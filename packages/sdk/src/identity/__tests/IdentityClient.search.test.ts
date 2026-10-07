import { IdentityClient, type ResolveByAttributesOptions } from '../IdentityClient'
import { ContactsManager, type Contact } from '../ContactsManager'
import { defaultIdentity, KNOWN_IDENTITY_TYPES } from '../types/index'
import type { IdentityCertificate, WalletInterface } from '../../wallet/Wallet.interfaces'

const contact: Contact = { ...defaultIdentity, name: 'Alice Smith', identityKey: 'alice-key' }
const certificate: IdentityCertificate = {
  type: KNOWN_IDENTITY_TYPES.emailCert,
  subject: 'public-key',
  serialNumber: 'test-certificate',
  certifier: 'certifier-key',
  revocationOutpoint: 'test-transaction.0',
  signature: '',
  fields: {},
  publiclyRevealedKeyring: {},
  decryptedFields: { email: 'alice@example.com' },
  certifierInfo: { name: 'Test certifier', iconUrl: '', description: 'Test certifier', trust: 1 }
}

function setup(certificates: IdentityCertificate[] = [certificate]) {
  const discoverByAttributes = jest.fn().mockResolvedValue({ certificates })
  const discoverByIdentityKey = jest.fn().mockResolvedValue({ certificates })
  const wallet = { discoverByAttributes, discoverByIdentityKey } as unknown as WalletInterface
  const contacts = jest.spyOn(ContactsManager.prototype, 'getContacts').mockResolvedValue([])
  const client = new IdentityClient(wallet, {}, 'search.example')
  return { client, contacts, discoverByAttributes, discoverByIdentityKey }
}

describe('Identity search contact enrichment', () => {
  afterEach(() => {
    jest.restoreAllMocks()
    jest.useRealTimers()
  })

  it.each(['alice', 'SMITH', 'ice sm', 'ICE-KEY', ' alice '])(
    'matches any-field substrings against local name and identity key: %s',
    async query => {
      const { client, contacts, discoverByAttributes } = setup([])
      contacts.mockResolvedValue([contact])
      await expect(
        client.resolveByAttributes({ attributes: { any: query } }, true)
      ).resolves.toEqual([contact])
      expect(discoverByAttributes).not.toHaveBeenCalled()
    }
  )

  it.each<Record<string, string>>([
    { name: 'alice' },
    { any: 'alice', name: 'Bob' },
    { any: 'alice', email: 'alice@example.com' },
    { any: 'unknown' }
  ])('retains exact named matching and all-selector conjunction: %j', async attributes => {
    const { client, contacts, discoverByAttributes } = setup([])
    contacts.mockResolvedValue([contact])
    await expect(client.resolveByAttributes({ attributes }, true)).resolves.toEqual([])
    expect(discoverByAttributes).toHaveBeenCalledTimes(1)
  })

  it('retains case-insensitive exact named matches', async () => {
    const { client, contacts, discoverByAttributes } = setup([])
    contacts.mockResolvedValue([contact])
    await expect(
      client.resolveByAttributes({ attributes: { any: 'smith', name: 'ALICE SMITH' } }, true)
    ).resolves.toEqual([contact])
    expect(discoverByAttributes).not.toHaveBeenCalled()
  })

  it('includes contact-only matches alongside fresh public results in parallel mode', async () => {
    const { client, contacts, discoverByAttributes } = setup()
    contacts.mockResolvedValue([contact])
    const result = await client.resolveByAttributes(
      { attributes: { any: 'alice' } },
      { useContacts: true, parallel: true }
    )
    expect(result.map(identity => identity.identityKey)).toEqual(['alice-key', 'public-key'])
    expect(result[0]).toEqual(contact)
    expect(result[1].name).toBe('alice@example.com')
    expect(discoverByAttributes).toHaveBeenCalledWith(
      { attributes: { any: 'alice' } },
      'search.example'
    )
  })

  it('retains parallel contact-only matches when public discovery is empty', async () => {
    const { client, contacts } = setup([])
    contacts.mockResolvedValue([contact])
    await expect(
      client.resolveByAttributes(
        { attributes: { any: 'alice' } },
        {
          useContacts: true,
          parallel: true
        }
      )
    ).resolves.toEqual([contact])
  })

  it.each([{ any: ' ' }, { any: '.*' }, { any: 'alice', name: '' }, { any: 'alice', name: 1 }])(
    'does not broaden local matches for empty, literal, or malformed selectors: %j',
    async attributes => {
      const { client, contacts, discoverByAttributes } = setup([])
      contacts.mockResolvedValue([contact])
      await expect(
        client.resolveByAttributes(
          { attributes } as Parameters<IdentityClient['resolveByAttributes']>[0],
          true
        )
      ).resolves.toEqual([])
      expect(discoverByAttributes).toHaveBeenCalledTimes(1)
    }
  )

  it('keeps the combined parallel result within the existing identity-result ceiling', async () => {
    const { client, contacts } = setup(Array.from({ length: 10000 }, () => certificate))
    contacts.mockResolvedValue([contact])
    await expect(
      client.resolveByAttributes(
        { attributes: { any: 'alice' } },
        {
          useContacts: true,
          parallel: true
        }
      )
    ).rejects.toThrow('Identity resolution exceeded 10000 results')
  })

  it('preserves public presentation validation after a contact fallback', async () => {
    const { client, contacts } = setup([
      { ...certificate, decryptedFields: { email: 'alice\u0000@example.com' } }
    ])
    contacts.mockRejectedValue(new Error('Contacts unavailable'))
    await expect(
      client.resolveByAttributes(
        { attributes: { any: 'alice' } },
        {
          useContacts: true,
          contactErrorMode: 'fallback'
        }
      )
    ).rejects.toThrow('unsafe controls')
  })

  it('does not duplicate a matching contact that overrides a public certificate', async () => {
    const { client, contacts } = setup([
      { ...certificate, subject: contact.identityKey },
      { ...certificate, subject: contact.identityKey }
    ])
    contacts.mockResolvedValue([contact])
    await expect(
      client.resolveByAttributes(
        { attributes: { any: 'alice' } },
        { useContacts: true, parallel: true }
      )
    ).resolves.toEqual([contact])
  })

  it.each([
    false,
    { useContacts: false },
    { useContacts: true, overrideWithContacts: false, contactErrorMode: 'fallback' }
  ])('preserves contact opt-out and legacy alias precedence: %j', async options => {
    const { client, contacts } = setup()
    const result = await client.resolveByAttributes(
      { attributes: { any: 'alice' } },
      options as boolean | ResolveByAttributesOptions
    )
    expect(result).toHaveLength(1)
    expect(contacts).not.toHaveBeenCalled()
  })

  it.each([true, { useContacts: true }, { useContacts: true, parallel: true }])(
    'preserves the original contact error for existing callers: %j',
    async options => {
      const { client, contacts } = setup()
      const failure = new Error('Contacts permission denied')
      contacts.mockRejectedValue(failure)
      await expect(
        client.resolveByAttributes({ attributes: { any: 'alice' } }, options)
      ).rejects.toBe(failure)
    }
  )

  it.each([false, true])('falls back only for contact failures, parallel=%s', async parallel => {
    const { client, contacts, discoverByAttributes } = setup()
    const failure = new Error('Contacts permission denied')
    contacts.mockRejectedValue(failure)
    const onContactError = jest.fn()
    const result = await client.resolveByAttributes(
      { attributes: { any: 'alice' } },
      {
        useContacts: true,
        parallel,
        contactErrorMode: 'fallback',
        onContactError
      }
    )
    expect(result[0].name).toBe('alice@example.com')
    expect(onContactError).toHaveBeenCalledTimes(1)
    expect(onContactError).toHaveBeenCalledWith(failure)
    expect(discoverByAttributes).toHaveBeenCalledTimes(1)
  })

  it('applies the same contact recovery to identity-key discovery', async () => {
    const { client, contacts, discoverByIdentityKey } = setup()
    contacts.mockRejectedValue(new Error('Contacts unavailable'))
    const result = await client.resolveByIdentityKey(
      { identityKey: 'public-key' },
      { useContacts: true, contactErrorMode: 'fallback' }
    )
    expect(result).toHaveLength(1)
    expect(discoverByIdentityKey).toHaveBeenCalledWith(
      { identityKey: 'public-key' },
      'search.example'
    )
  })

  it.each([false, true])(
    'preserves public discovery errors in fallback mode, parallel=%s',
    async parallel => {
      const { client, contacts, discoverByAttributes } = setup()
      contacts.mockRejectedValue(new Error('Contacts unavailable'))
      const denied = new Error('Identity resolution permission denied')
      discoverByAttributes.mockRejectedValue(denied)
      await expect(
        client.resolveByAttributes(
          { attributes: { any: 'alice' } },
          {
            useContacts: true,
            parallel,
            contactErrorMode: 'fallback'
          }
        )
      ).rejects.toBe(denied)
    }
  )

  it('continues public lookup at the default fallback deadline and ignores late contacts', async () => {
    jest.useFakeTimers()
    const { client, contacts, discoverByAttributes } = setup()
    let completeContacts: (value: Contact[]) => void = () => {
      throw new Error('not initialized')
    }
    contacts.mockImplementation(
      () =>
        new Promise(resolve => {
          completeContacts = resolve
        })
    )
    const onContactError = jest.fn()
    const pending = client.resolveByAttributes(
      { attributes: { any: 'alice' } },
      {
        useContacts: true,
        contactErrorMode: 'fallback',
        onContactError
      }
    )
    await jest.advanceTimersByTimeAsync(1999)
    expect(discoverByAttributes).not.toHaveBeenCalled()
    await jest.advanceTimersByTimeAsync(1)
    const result = await pending
    expect(result.map(identity => identity.identityKey)).toEqual(['public-key'])
    expect(onContactError).toHaveBeenCalledTimes(1)
    expect(onContactError.mock.calls[0][0].message).toBe('Identity contact resolution timed out')
    completeContacts([contact])
    await Promise.resolve()
    expect(result.map(identity => identity.identityKey)).toEqual(['public-key'])
    expect(jest.getTimerCount()).toBe(0)
  })

  it('cleans its deadline after a successful contact hit', async () => {
    jest.useFakeTimers()
    const { client, contacts, discoverByAttributes } = setup()
    contacts.mockResolvedValue([contact])
    const onContactError = jest.fn()
    await expect(
      client.resolveByAttributes(
        { attributes: { any: 'alice' } },
        {
          useContacts: true,
          contactErrorMode: 'fallback',
          contactTimeoutMs: 50,
          onContactError
        }
      )
    ).resolves.toEqual([contact])
    expect(jest.getTimerCount()).toBe(0)
    expect(discoverByAttributes).not.toHaveBeenCalled()
    expect(onContactError).not.toHaveBeenCalled()
  })

  it('propagates an explicitly bounded strict timeout without public discovery', async () => {
    jest.useFakeTimers()
    const { client, contacts, discoverByAttributes } = setup()
    contacts.mockImplementation(() => new Promise(() => {}))
    const pending = expect(
      client.resolveByAttributes(
        { attributes: { any: 'alice' } },
        {
          useContacts: true,
          contactTimeoutMs: 1
        }
      )
    ).rejects.toThrow('Identity contact resolution timed out')
    await jest.advanceTimersByTimeAsync(1)
    await pending
    expect(discoverByAttributes).not.toHaveBeenCalled()
    expect(jest.getTimerCount()).toBe(0)
  })

  it('propagates diagnostic callback failures', async () => {
    const { client, contacts } = setup()
    contacts.mockRejectedValue(new Error('Contacts unavailable'))
    const callbackFailure = new Error('UI diagnostics failed')
    await expect(
      client.resolveByAttributes(
        { attributes: { any: 'alice' } },
        {
          useContacts: true,
          contactErrorMode: 'fallback',
          onContactError: () => {
            throw callbackFailure
          }
        }
      )
    ).rejects.toBe(callbackFailure)
  })

  it.each([
    { contactErrorMode: null },
    { contactErrorMode: 'ignore' },
    { contactTimeoutMs: 0 },
    { contactTimeoutMs: 60001 },
    { contactTimeoutMs: -1 },
    { contactTimeoutMs: 1.5 },
    { contactTimeoutMs: NaN },
    { contactTimeoutMs: Infinity },
    { contactTimeoutMs: '100' },
    { onContactError: true }
  ])('rejects invalid recovery options before wallet work: %j', async options => {
    const { client, contacts, discoverByAttributes } = setup()
    await expect(
      client.resolveByAttributes(
        { attributes: { any: 'alice' } },
        options as ResolveByAttributesOptions
      )
    ).rejects.toThrow('Invalid identity options')
    expect(contacts).not.toHaveBeenCalled()
    expect(discoverByAttributes).not.toHaveBeenCalled()
  })
})
