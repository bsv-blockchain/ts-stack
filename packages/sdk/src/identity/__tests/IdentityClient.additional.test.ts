import { WalletInterface } from '../../wallet/index'
import { IdentityClient } from '../IdentityClient'
import { KNOWN_IDENTITY_TYPES, defaultIdentity } from '../types/index.js'
import Certificate from '../../auth/certificates/Certificate.js'

const VALID_SERIAL = 'AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE='
const IDENTITY_KEY = `02${'11'.repeat(32)}`
const CERTIFIER_KEY = `03${'22'.repeat(32)}`
const MOCK_TXID = 'ab'.repeat(32)

function revelationPayload(serialNumber = VALID_SERIAL, subject = IDENTITY_KEY): number[] {
  return Array.from(
    new TextEncoder().encode(
      JSON.stringify({
        type: VALID_SERIAL,
        serialNumber,
        subject,
        certifier: CERTIFIER_KEY,
        revocationOutpoint: `${'cd'.repeat(32)}.0`,
        fields: { name: 'encrypted' },
        keyring: { name: VALID_SERIAL },
        signature: '3006020101020101'
      })
    )
  )
}

function revelationScript(hex = 'scriptHex') {
  const payload = revelationPayload()
  const signature = [48, 6, 2, 1, 1, 2, 1, 1]
  return {
    toHex: () => hex,
    chunks: [
      { op: 33, data: new Uint8Array(33) },
      { op: 0xac },
      { op: payload.length <= 0xff ? 0x4c : 0x4d, data: payload },
      { op: signature.length, data: signature },
      { op: 0x6d }
    ]
  }
}

// ----- Mocks for external dependencies -----
jest.mock('../../script/templates/PushDrop.js', () => {
  const mockPushDropInstance = {
    lock: jest.fn().mockResolvedValue({
      toHex: () => 'lockingScriptHex'
    }),
    unlock: jest.fn().mockReturnValue({
      sign: jest.fn().mockResolvedValue({
        toHex: () => 'unlockingScriptHex'
      })
    })
  }

  const mockPushDrop: any = jest.fn().mockImplementation(() => mockPushDropInstance)
  mockPushDrop.decode = jest.fn().mockReturnValue({
    lockingPublicKey: { toString: () => IDENTITY_KEY },
    fields: [new Uint8Array([1, 2, 3, 4])]
  })

  return {
    __esModule: true,
    default: mockPushDrop
  }
})

jest.mock('../../script/LockingScript.js', () => {
  return {
    __esModule: true,
    default: {
      fromHex: jest.fn().mockImplementation((hex: string) => ({
        toHex: () => hex,
        chunks: [
          { op: 33, data: new Uint8Array(33) },
          { op: 0xac },
          { op: 4, data: new Uint8Array([1, 2, 3, 4]) },
          { op: 8, data: new Uint8Array(8) },
          { op: 0x6d }
        ]
      }))
    }
  }
})

jest.mock('../../overlay-tools/SHIPBroadcaster.js', () => {
  return {
    __esModule: true,
    default: jest.fn().mockImplementation(() => ({
      broadcast: jest.fn().mockResolvedValue('broadcastResult')
    }))
  }
})

jest.mock('../../overlay-tools/LookupResolver.js', () => {
  return {
    __esModule: true,
    default: jest.fn().mockImplementation(() => ({
      query: jest.fn().mockResolvedValue({
        type: 'output-list',
        outputs: [
          {
            beef: [1, 2, 3]
          }
        ]
      })
    }))
  }
})

jest.mock('../../overlay-tools/withDoubleSpendRetry.js', () => {
  return {
    withDoubleSpendRetry: jest.fn().mockImplementation(async (fn: () => Promise<void>) => {
      await fn()
    })
  }
})

jest.mock('../../transaction/Transaction.js', () => {
  return {
    __esModule: true,
    default: {
      fromAtomicBEEF: jest.fn().mockImplementation(_tx => ({
        toHexBEEF: () => 'transactionHex'
      })),
      fromBEEF: jest.fn().mockReturnValue({
        id: jest.fn().mockReturnValue('mocktxid'),
        outputs: [
          {
            lockingScript: {
              toHex: () => 'mockLockingScript'
            }
          }
        ]
      })
    }
  }
})

jest.mock('../../primitives/index.js', () => {
  return {
    Utils: {
      toBase64: jest.fn().mockReturnValue('mockKeyID'),
      toArray: jest.fn().mockReturnValue(new Uint8Array()),
      toUTF8: jest.fn().mockImplementation(data => {
        return new TextDecoder().decode(data)
      }),
      toUTF8Strict: jest.fn().mockImplementation(data => {
        return new TextDecoder('utf-8', { fatal: true }).decode(new Uint8Array(data))
      }),
      toHex: jest.fn().mockReturnValue('0102030405060708')
    },
    Random: jest.fn().mockReturnValue(new Uint8Array(32)),
    PrivateKey: jest.fn().mockImplementation(() => ({
      toPublicKey: jest.fn().mockReturnValue({
        toString: jest.fn().mockReturnValue('mockPublicKeyString')
      })
    }))
  }
})

// ----- Begin Test Suite -----
describe('IdentityClient (additional coverage)', () => {
  let walletMock: Partial<WalletInterface>
  let identityClient: IdentityClient

  beforeEach(() => {
    const localStorageMock = {
      getItem: jest.fn(),
      setItem: jest.fn(),
      removeItem: jest.fn()
    }
    Object.defineProperty(global, 'localStorage', {
      value: localStorageMock,
      writable: true
    })

    walletMock = {
      proveCertificate: jest.fn().mockResolvedValue({
        keyringForVerifier: { name: VALID_SERIAL }
      }),
      createAction: jest.fn().mockResolvedValue({
        tx: [1, 2, 3],
        signableTransaction: { tx: [1, 2, 3], reference: 'ref' }
      }),
      listCertificates: jest.fn().mockResolvedValue({ certificates: [] }),
      acquireCertificate: jest.fn().mockResolvedValue({
        fields: { name: 'Alice' },
        verify: jest.fn().mockResolvedValue(true)
      }),
      signAction: jest.fn().mockResolvedValue({ tx: [4, 5, 6] }),
      abortAction: jest.fn().mockResolvedValue({ aborted: true }),
      getPublicKey: jest.fn().mockResolvedValue({ publicKey: IDENTITY_KEY }),
      verifySignature: jest.fn().mockResolvedValue({ valid: true }),
      getNetwork: jest.fn().mockResolvedValue({ network: 'testnet' }),
      discoverByIdentityKey: jest.fn().mockResolvedValue({ certificates: [] }),
      discoverByAttributes: jest.fn().mockResolvedValue({ certificates: [] }),
      listOutputs: jest.fn().mockResolvedValue({ outputs: [], BEEF: [] }),
      createHmac: jest.fn().mockResolvedValue({ hmac: new Uint8Array([1, 2, 3, 4]) }),
      decrypt: jest.fn().mockResolvedValue({ plaintext: new Uint8Array() }),
      encrypt: jest.fn().mockResolvedValue({ ciphertext: new Uint8Array([5, 6, 7, 8]) })
    }

    identityClient = new IdentityClient(walletMock as WalletInterface)
    jest.clearAllMocks()
  })

  // ─── parseIdentity: remaining known cert types ──────────────────────────────

  describe('parseIdentity — remaining known cert types', () => {
    it('parses discordCert correctly', () => {
      const cert = {
        type: KNOWN_IDENTITY_TYPES.discordCert,
        subject: 'discordSubject123',
        decryptedFields: { userName: 'DiscordUser', profilePhoto: 'discord-photo.png' },
        certifierInfo: { name: 'DiscordCertifier', iconUrl: 'discord-icon.png' }
      }
      const result = IdentityClient.parseIdentity(cert as any)
      expect(result.name).toBe('DiscordUser')
      expect(result.avatarURL).toBe('discord-photo.png')
      expect(result.badgeLabel).toBe('Discord account certified by DiscordCertifier')
      expect(result.badgeIconURL).toBe('discord-icon.png')
      expect(result.badgeClickURL).toBe('https://socialcert.net')
      expect(result.identityKey).toBe('discordSubject123')
      expect(result.abbreviatedKey).toBe('discordSub...')
    })

    it('parses emailCert correctly', () => {
      const cert = {
        type: KNOWN_IDENTITY_TYPES.emailCert,
        subject: 'emailSubjectABC',
        decryptedFields: { email: 'user@example.com' },
        certifierInfo: { name: 'EmailCertifier', iconUrl: 'email-icon.png' }
      }
      const result = IdentityClient.parseIdentity(cert as any)
      expect(result.name).toBe('user@example.com')
      // avatarURL is a hard-coded constant for email
      expect(result.avatarURL).toBe('XUTZxep7BBghAJbSBwTjNfmcsDdRFs5EaGEgkESGSgjJVYgMEizu')
      expect(result.badgeLabel).toBe('Email certified by EmailCertifier')
      expect(result.badgeIconURL).toBe('email-icon.png')
      expect(result.badgeClickURL).toBe('https://socialcert.net')
    })

    it('parses phoneCert correctly', () => {
      const cert = {
        type: KNOWN_IDENTITY_TYPES.phoneCert,
        subject: 'phoneSubjectXYZ',
        decryptedFields: { phoneNumber: '+15555551234' },
        certifierInfo: { name: 'PhoneCertifier', iconUrl: 'phone-icon.png' }
      }
      const result = IdentityClient.parseIdentity(cert as any)
      expect(result.name).toBe('+15555551234')
      // avatarURL is a hard-coded constant for phone
      expect(result.avatarURL).toBe('XUTLxtX3ELNUwRhLwL7kWNGbdnFM8WG2eSLv84J7654oH8HaJWrU')
      expect(result.badgeLabel).toBe('Phone certified by PhoneCertifier')
      expect(result.badgeClickURL).toBe('https://socialcert.net')
    })

    it('parses identiCert correctly', () => {
      const cert = {
        type: KNOWN_IDENTITY_TYPES.identiCert,
        subject: 'identiSubjectFOO',
        decryptedFields: { firstName: 'Jane', lastName: 'Doe', profilePhoto: 'id-photo.png' },
        certifierInfo: { name: 'GovCertifier', iconUrl: 'gov-icon.png' }
      }
      const result = IdentityClient.parseIdentity(cert as any)
      expect(result.name).toBe('Jane Doe')
      expect(result.avatarURL).toBe('id-photo.png')
      expect(result.badgeLabel).toBe('Government ID certified by GovCertifier')
      expect(result.badgeClickURL).toBe('https://identicert.me')
    })

    it('parses registrant correctly', () => {
      const cert = {
        type: KNOWN_IDENTITY_TYPES.registrant,
        subject: 'registrantSubject',
        decryptedFields: { name: 'ACME Corp', icon: 'acme-icon.png' },
        certifierInfo: { name: 'RegistryCertifier', iconUrl: 'registry-icon.png' }
      }
      const result = IdentityClient.parseIdentity(cert as any)
      expect(result.name).toBe('ACME Corp')
      expect(result.avatarURL).toBe('acme-icon.png')
      expect(result.badgeLabel).toBe('Entity certified by RegistryCertifier')
      expect(result.badgeClickURL).toBe(
        'https://bsv-blockchain.github.io/ts-sdk/reference/identity/'
      )
    })

    it('parses coolCert with cool=true', () => {
      const cert = {
        type: KNOWN_IDENTITY_TYPES.coolCert,
        subject: 'coolSubject001',
        decryptedFields: { cool: 'true' },
        certifierInfo: {}
      }
      const result = IdentityClient.parseIdentity(cert as any)
      expect(result.name).toBe('Cool Person!')
    })

    it('parses coolCert with cool != true', () => {
      const cert = {
        type: KNOWN_IDENTITY_TYPES.coolCert,
        subject: 'coolSubject002',
        decryptedFields: { cool: 'false' },
        certifierInfo: {}
      }
      const result = IdentityClient.parseIdentity(cert as any)
      expect(result.name).toBe('Not cool!')
    })

    it('parses anyone identity type', () => {
      const cert = {
        type: KNOWN_IDENTITY_TYPES.anyone,
        subject: 'anyoneSubjectAAA',
        decryptedFields: {},
        certifierInfo: {}
      }
      const result = IdentityClient.parseIdentity(cert as any)
      expect(result.name).toBe('Anyone')
      expect(result.avatarURL).toBe('XUT4bpQ6cpBaXi1oMzZsXfpkWGbtp2JTUYAoN7PzhStFJ6wLfoeR')
      expect(result.badgeLabel).toBe(
        'Represents the ability for anyone to access this information.'
      )
      expect(result.badgeClickURL).toBe(
        'https://bsv-blockchain.github.io/ts-sdk/reference/identity/'
      )
    })

    it('parses self identity type', () => {
      const cert = {
        type: KNOWN_IDENTITY_TYPES.self,
        subject: 'selfSubjectBBB',
        decryptedFields: {},
        certifierInfo: {}
      }
      const result = IdentityClient.parseIdentity(cert as any)
      expect(result.name).toBe('You')
      expect(result.avatarURL).toBe('XUT9jHGk2qace148jeCX5rDsMftkSGYKmigLwU2PLLBc7Hm63VYR')
      expect(result.badgeLabel).toBe('Represents your ability to access this information.')
      expect(result.badgeClickURL).toBe(
        'https://bsv-blockchain.github.io/ts-sdk/reference/identity/'
      )
    })

    it('produces empty abbreviatedKey when subject is empty string', () => {
      const cert = {
        type: KNOWN_IDENTITY_TYPES.anyone,
        subject: '',
        decryptedFields: {},
        certifierInfo: {}
      }
      const result = IdentityClient.parseIdentity(cert as any)
      expect(result.abbreviatedKey).toBe('')
    })

    it('abbreviatedKey is subject.substring(0,10)+"..." when subject is non-empty', () => {
      const cert = {
        type: KNOWN_IDENTITY_TYPES.anyone,
        subject: '0123456789ABCDEF',
        decryptedFields: {},
        certifierInfo: {}
      }
      const result = IdentityClient.parseIdentity(cert as any)
      expect(result.abbreviatedKey).toBe('0123456789...')
    })
  })

  // ─── parseIdentity: generic/unknown type — tryToParseGenericIdentity paths ──

  describe('parseIdentity — generic/unknown type (tryToParseGenericIdentity)', () => {
    it('uses decryptedFields.name when present', () => {
      const cert = {
        type: 'custom-type',
        subject: 'sub1',
        decryptedFields: { name: 'Custom Name' },
        certifierInfo: { name: 'SomeCert', iconUrl: 'some-icon.png' }
      }
      const result = IdentityClient.parseIdentity(cert as any)
      expect(result.name).toBe('Custom Name')
    })

    it('falls back to decryptedFields.userName when name is absent', () => {
      const cert = {
        type: 'custom-type',
        subject: 'sub1',
        decryptedFields: { userName: 'userNameValue' },
        certifierInfo: { name: 'SomeCert', iconUrl: 'icon.png' }
      }
      const result = IdentityClient.parseIdentity(cert as any)
      expect(result.name).toBe('userNameValue')
    })

    it('falls back to firstName + lastName when both present', () => {
      const cert = {
        type: 'custom-type',
        subject: 'sub1',
        decryptedFields: { firstName: 'John', lastName: 'Smith' },
        certifierInfo: {}
      }
      const result = IdentityClient.parseIdentity(cert as any)
      expect(result.name).toBe('John Smith')
    })

    it('uses only firstName when lastName is absent', () => {
      const cert = {
        type: 'custom-type',
        subject: 'sub1',
        decryptedFields: { firstName: 'OnlyFirst' },
        certifierInfo: {}
      }
      const result = IdentityClient.parseIdentity(cert as any)
      expect(result.name).toBe('OnlyFirst')
    })

    it('uses only lastName when firstName is absent', () => {
      const cert = {
        type: 'custom-type',
        subject: 'sub1',
        decryptedFields: { lastName: 'OnlyLast' },
        certifierInfo: {}
      }
      const result = IdentityClient.parseIdentity(cert as any)
      expect(result.name).toBe('OnlyLast')
    })

    it('falls back to email when no name/userName/firstName/lastName', () => {
      const cert = {
        type: 'custom-type',
        subject: 'sub1',
        decryptedFields: { email: 'generic@example.com' },
        certifierInfo: {}
      }
      const result = IdentityClient.parseIdentity(cert as any)
      expect(result.name).toBe('generic@example.com')
    })

    it('uses defaultIdentity.name when no name fields exist', () => {
      const cert = {
        type: 'custom-type',
        subject: 'sub1',
        decryptedFields: {},
        certifierInfo: {}
      }
      const result = IdentityClient.parseIdentity(cert as any)
      expect(result.name).toBe(defaultIdentity.name)
    })

    it('uses decryptedFields.profilePhoto for avatarURL', () => {
      const cert = {
        type: 'custom-type',
        subject: 'sub1',
        decryptedFields: { name: 'X', profilePhoto: 'profile.png' },
        certifierInfo: {}
      }
      const result = IdentityClient.parseIdentity(cert as any)
      expect(result.avatarURL).toBe('profile.png')
    })

    it('falls back to decryptedFields.avatar for avatarURL', () => {
      const cert = {
        type: 'custom-type',
        subject: 'sub1',
        decryptedFields: { name: 'X', avatar: 'avatar.png' },
        certifierInfo: {}
      }
      const result = IdentityClient.parseIdentity(cert as any)
      expect(result.avatarURL).toBe('avatar.png')
    })

    it('falls back to decryptedFields.icon for avatarURL', () => {
      const cert = {
        type: 'custom-type',
        subject: 'sub1',
        decryptedFields: { name: 'X', icon: 'icon.png' },
        certifierInfo: {}
      }
      const result = IdentityClient.parseIdentity(cert as any)
      expect(result.avatarURL).toBe('icon.png')
    })

    it('falls back to decryptedFields.photo for avatarURL', () => {
      const cert = {
        type: 'custom-type',
        subject: 'sub1',
        decryptedFields: { name: 'X', photo: 'photo.png' },
        certifierInfo: {}
      }
      const result = IdentityClient.parseIdentity(cert as any)
      expect(result.avatarURL).toBe('photo.png')
    })

    it('uses defaultIdentity.avatarURL when no avatar field is present', () => {
      const cert = {
        type: 'custom-type',
        subject: 'sub1',
        decryptedFields: { name: 'X' },
        certifierInfo: {}
      }
      const result = IdentityClient.parseIdentity(cert as any)
      expect(result.avatarURL).toBe(defaultIdentity.avatarURL)
    })

    it('generates badgeLabel from certifierInfo.name', () => {
      const cert = {
        type: 'my-cert-type',
        subject: 'sub1',
        decryptedFields: {},
        certifierInfo: { name: 'MyCertifier', iconUrl: 'cert-icon.png' }
      }
      const result = IdentityClient.parseIdentity(cert as any)
      expect(result.badgeLabel).toBe('my-cert-type certified by MyCertifier')
    })

    it('uses defaultIdentity.badgeLabel when certifierInfo.name is absent', () => {
      const cert = {
        type: 'my-cert-type',
        subject: 'sub1',
        decryptedFields: {},
        certifierInfo: {}
      }
      const result = IdentityClient.parseIdentity(cert as any)
      expect(result.badgeLabel).toBe(defaultIdentity.badgeLabel)
    })

    it('uses certifierInfo.iconUrl for badgeIconURL when present', () => {
      const cert = {
        type: 'my-cert-type',
        subject: 'sub1',
        decryptedFields: {},
        certifierInfo: { name: 'Cert', iconUrl: 'specific-icon.png' }
      }
      const result = IdentityClient.parseIdentity(cert as any)
      expect(result.badgeIconURL).toBe('specific-icon.png')
    })

    it('uses defaultIdentity.badgeIconURL when certifierInfo.iconUrl is absent', () => {
      const cert = {
        type: 'my-cert-type',
        subject: 'sub1',
        decryptedFields: {},
        certifierInfo: { name: 'Cert' }
      }
      const result = IdentityClient.parseIdentity(cert as any)
      expect(result.badgeIconURL).toBe(defaultIdentity.badgeIconURL)
    })

    it('always uses defaultIdentity.badgeClickURL', () => {
      const cert = {
        type: 'my-cert-type',
        subject: 'sub1',
        decryptedFields: {},
        certifierInfo: {}
      }
      const result = IdentityClient.parseIdentity(cert as any)
      expect(result.badgeClickURL).toBe(defaultIdentity.badgeClickURL)
    })

    it('handles null certifierInfo gracefully', () => {
      const cert = {
        type: 'my-cert-type',
        subject: 'sub1',
        decryptedFields: {},
        certifierInfo: null
      }
      const result = IdentityClient.parseIdentity(cert as any)
      expect(result.badgeLabel).toBe(defaultIdentity.badgeLabel)
      expect(result.badgeIconURL).toBe(defaultIdentity.badgeIconURL)
    })

    it('treats empty-string field values as absent (hasValue returns false)', () => {
      const cert = {
        type: 'my-cert-type',
        subject: 'sub1',
        decryptedFields: {
          name: '',
          userName: '',
          firstName: '',
          lastName: '',
          email: ''
        },
        certifierInfo: {}
      }
      const result = IdentityClient.parseIdentity(cert as any)
      expect(result.name).toBe(defaultIdentity.name)
    })

    it('rejects active-content resource schemes from identity fields and certifier metadata', () => {
      expect(() =>
        IdentityClient.parseIdentity({
          type: 'custom-type',
          subject: 'sub1',
          decryptedFields: { name: 'Alice', profilePhoto: 'javascript:alert(1)' },
          certifierInfo: {}
        } as any)
      ).toThrow('unsafe URL scheme')

      expect(() =>
        IdentityClient.parseIdentity({
          type: 'custom-type',
          subject: 'sub1',
          decryptedFields: { name: 'Alice' },
          certifierInfo: { iconUrl: 'data:text/html,<script>alert(1)</script>' }
        } as any)
      ).toThrow('unsafe URL scheme')
    })

    it('rejects accessors without invoking identity-controlled code', () => {
      let getterCalls = 0
      const fields: Record<string, unknown> = { name: 'Alice' }
      Object.defineProperty(fields, 'profilePhoto', {
        enumerable: true,
        get: () => {
          getterCalls++
          return 'https://attacker.example/track'
        }
      })

      expect(() =>
        IdentityClient.parseIdentity({
          type: 'custom-type',
          subject: 'sub1',
          decryptedFields: fields,
          certifierInfo: {}
        } as any)
      ).toThrow('data property')
      expect(getterCalls).toBe(0)
    })
  })

  // ─── resolveByIdentityKey: overrideWithContacts = false ────────────────────

  describe('resolveByIdentityKey with overrideWithContacts=false', () => {
    it('skips contacts and returns parsed certificates directly', async () => {
      const dummyCertificate = {
        type: KNOWN_IDENTITY_TYPES.xCert,
        subject: 'aliceKey123456789',
        decryptedFields: { userName: 'Alice', profilePhoto: 'photo.png' },
        certifierInfo: { name: 'CertX', iconUrl: 'icon.png' }
      }
      walletMock.discoverByIdentityKey = jest
        .fn()
        .mockResolvedValue({ certificates: [dummyCertificate] })

      const mockContactsManager = identityClient['contactsManager']
      mockContactsManager.getContacts = jest
        .fn()
        .mockResolvedValue([{ name: 'Alice Contact', identityKey: 'aliceKey123456789' }])

      const result = await identityClient.resolveByIdentityKey(
        { identityKey: 'aliceKey123456789' },
        false
      )

      expect(result).toHaveLength(1)
      expect(result[0].name).toBe('Alice') // from cert, not contact
      expect(mockContactsManager.getContacts).not.toHaveBeenCalled()
    })

    it('returns empty array when no certificates found and contacts skipped', async () => {
      walletMock.discoverByIdentityKey = jest.fn().mockResolvedValue({ certificates: [] })

      const result = await identityClient.resolveByIdentityKey(
        { identityKey: 'unknown-key' },
        false
      )
      expect(result).toEqual([])
    })

    it('handles undefined certificates result gracefully', async () => {
      walletMock.discoverByIdentityKey = jest.fn().mockResolvedValue({ certificates: undefined })

      const result = await identityClient.resolveByIdentityKey({ identityKey: 'some-key' }, false)
      expect(result).toEqual([])
    })
  })

  // ─── resolveByAttributes: additional branches ──────────────────────────────

  describe('resolveByAttributes additional branches', () => {
    it('handles null/undefined certificates result gracefully', async () => {
      walletMock.discoverByAttributes = jest.fn().mockResolvedValue(null)
      const result = await identityClient.resolveByAttributes(
        { attributes: { name: 'Alice' } },
        false
      )
      expect(result).toEqual([])
    })

    it('maps contact for subject when contact exists in map', async () => {
      const contact = {
        name: 'Alice From Contact',
        identityKey: 'matched-key',
        avatarURL: 'contact-avatar.png',
        abbreviatedKey: 'matched-ke...',
        badgeIconURL: '',
        badgeLabel: '',
        badgeClickURL: ''
      }
      const discoveredCertificate = {
        type: KNOWN_IDENTITY_TYPES.emailCert,
        subject: 'matched-key',
        decryptedFields: { email: 'alice@example.com' },
        certifierInfo: { name: 'EmailCert', iconUrl: '' }
      }
      const mockContactsManager = identityClient['contactsManager']
      mockContactsManager.getContacts = jest.fn().mockResolvedValue([contact])
      walletMock.discoverByAttributes = jest
        .fn()
        .mockResolvedValue({ certificates: [discoveredCertificate] })

      const result = await identityClient.resolveByAttributes(
        { attributes: { email: 'alice@example.com' } },
        { useContacts: true }
      )
      expect(result[0].name).toBe('Alice From Contact')
    })

    it('falls through to parseIdentity when no matching contact for subject', async () => {
      const contact = {
        name: 'Bob From Contact',
        identityKey: 'bob-key',
        avatarURL: '',
        abbreviatedKey: '',
        badgeIconURL: '',
        badgeLabel: '',
        badgeClickURL: ''
      }
      const discoveredCertificate = {
        type: KNOWN_IDENTITY_TYPES.emailCert,
        subject: 'alice-different-key',
        decryptedFields: { email: 'alice@example.com' },
        certifierInfo: { name: 'EmailCert', iconUrl: '' }
      }
      const mockContactsManager = identityClient['contactsManager']
      mockContactsManager.getContacts = jest.fn().mockResolvedValue([contact])
      walletMock.discoverByAttributes = jest
        .fn()
        .mockResolvedValue({ certificates: [discoveredCertificate] })

      const result = await identityClient.resolveByAttributes({
        attributes: { email: 'alice@example.com' }
      })
      expect(result[0].name).toBe('alice@example.com')
    })
  })

  // ─── revokeCertificateRevelation ────────────────────────────────────────────

  describe('revokeCertificateRevelation', () => {
    const LookupResolver = (jest.requireMock('../../overlay-tools/LookupResolver.js') as any)
      .default
    const SHIPBroadcaster = (jest.requireMock('../../overlay-tools/SHIPBroadcaster.js') as any)
      .default
    const { withDoubleSpendRetry } = jest.requireMock(
      '../../overlay-tools/withDoubleSpendRetry.js'
    ) as any
    const PushDrop = (jest.requireMock('../../script/templates/PushDrop.js') as any).default
    const Transaction = (jest.requireMock('../../transaction/Transaction.js') as any).default
    let certificateVerify: jest.SpiedFunction<Certificate['verify']>

    beforeAll(() => {
      certificateVerify = jest.spyOn(Certificate.prototype, 'verify')
    })

    afterAll(() => {
      certificateVerify.mockRestore()
    })

    beforeEach(() => {
      jest.clearAllMocks()
      certificateVerify.mockResolvedValue(true)
      PushDrop.decode.mockReturnValue({
        lockingPublicKey: { toString: () => IDENTITY_KEY },
        fields: [revelationPayload(), [48, 6, 2, 1, 1, 2, 1, 1]]
      })
      const parsedTransaction = {
        id: jest.fn().mockReturnValue(MOCK_TXID),
        inputs: [
          {
            sourceTXID: MOCK_TXID,
            sourceOutputIndex: 0,
            unlockingScript: { toHex: () => 'unlockingScriptHex' }
          }
        ],
        outputs: [{ lockingScript: revelationScript(), satoshis: 1 }]
      }
      Transaction.fromBEEF.mockReturnValue(parsedTransaction)
      Transaction.fromAtomicBEEF.mockReturnValue(parsedTransaction)
      SHIPBroadcaster.mockImplementation(() => ({
        broadcast: jest.fn().mockResolvedValue({
          status: 'success',
          txid: MOCK_TXID,
          message: 'broadcasted'
        })
      }))
      withDoubleSpendRetry.mockImplementation(async (fn: () => Promise<void>) => {
        await fn()
      })
    })

    it('throws when lookup result type is not output-list', async () => {
      LookupResolver.mockImplementation(() => ({
        query: jest.fn().mockResolvedValue({ type: 'freeform', result: 'some data' })
      }))

      await expect(identityClient.revokeCertificateRevelation(VALID_SERIAL)).rejects.toThrow(
        'Failed to get lookup result'
      )
    })

    it('completes successfully with valid lookup output', async () => {
      LookupResolver.mockImplementation(() => ({
        query: jest.fn().mockResolvedValue({
          type: 'output-list',
          outputs: [{ beef: [1, 2, 3], outputIndex: 0 }]
        })
      }))

      walletMock.createAction = jest.fn().mockResolvedValue({
        signableTransaction: { tx: [1, 2, 3], reference: 'ref' },
        tx: undefined
      })
      walletMock.signAction = jest.fn().mockResolvedValue({ tx: [4, 5, 6] })

      await expect(
        identityClient.revokeCertificateRevelation(VALID_SERIAL)
      ).resolves.toBeUndefined()
    })

    it('throws when signableTransaction is undefined', async () => {
      LookupResolver.mockImplementation(() => ({
        query: jest.fn().mockResolvedValue({
          type: 'output-list',
          outputs: [{ beef: [1, 2, 3], outputIndex: 0 }]
        })
      }))

      walletMock.createAction = jest.fn().mockResolvedValue({
        signableTransaction: undefined,
        tx: undefined
      })

      await expect(identityClient.revokeCertificateRevelation(VALID_SERIAL)).rejects.toThrow(
        'Failed to create signable transaction'
      )
    })

    it('throws when signed tx is undefined after signAction', async () => {
      LookupResolver.mockImplementation(() => ({
        query: jest.fn().mockResolvedValue({
          type: 'output-list',
          outputs: [{ beef: [1, 2, 3], outputIndex: 0 }]
        })
      }))

      walletMock.createAction = jest.fn().mockResolvedValue({
        signableTransaction: { tx: [1, 2, 3], reference: 'ref' },
        tx: undefined
      })
      walletMock.signAction = jest.fn().mockResolvedValue({ tx: undefined })

      await expect(identityClient.revokeCertificateRevelation(VALID_SERIAL)).rejects.toThrow(
        'Failed to sign transaction'
      )
    })

    it('rejects a lookup output whose authenticated payload has a different serial', async () => {
      LookupResolver.mockImplementation(() => ({
        query: jest.fn().mockResolvedValue({
          type: 'output-list',
          outputs: [{ beef: [1, 2, 3], outputIndex: 0 }]
        })
      }))
      PushDrop.decode.mockReturnValue({
        lockingPublicKey: { toString: () => IDENTITY_KEY },
        fields: [
          revelationPayload('AgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgI='),
          [48, 6, 2, 1, 1, 2, 1, 1]
        ]
      })

      await expect(identityClient.revokeCertificateRevelation(VALID_SERIAL)).rejects.toThrow(
        'No authenticated revelation output matches'
      )
      expect(walletMock.createAction).not.toHaveBeenCalled()
    })

    it('rejects a token that is not signed by the current wallet', async () => {
      LookupResolver.mockImplementation(() => ({
        query: jest.fn().mockResolvedValue({
          type: 'output-list',
          outputs: [{ beef: [1, 2, 3], outputIndex: 0 }]
        })
      }))
      ;(walletMock.verifySignature as jest.Mock).mockResolvedValue({ valid: false })

      await expect(identityClient.revokeCertificateRevelation(VALID_SERIAL)).rejects.toThrow(
        'No authenticated revelation output matches'
      )
      expect(walletMock.createAction).not.toHaveBeenCalled()
    })

    it('rejects a revelation output locked to a different derived key', async () => {
      PushDrop.decode.mockReturnValue({
        lockingPublicKey: { toString: () => CERTIFIER_KEY },
        fields: [revelationPayload(), [48, 6, 2, 1, 1, 2, 1, 1]]
      })

      await expect(identityClient.revokeCertificateRevelation(VALID_SERIAL)).rejects.toThrow(
        'No authenticated revelation output matches'
      )
      expect(walletMock.verifySignature).not.toHaveBeenCalled()
      expect(walletMock.createAction).not.toHaveBeenCalled()
    })

    it('uses the resolver output index and the actual partial-transaction input index', async () => {
      LookupResolver.mockImplementation(() => ({
        query: jest.fn().mockResolvedValue({
          type: 'output-list',
          outputs: [{ beef: [1, 2, 3], outputIndex: 1 }]
        })
      }))
      const sourceTransaction = {
        id: jest.fn().mockReturnValue(MOCK_TXID),
        inputs: [],
        outputs: [
          { lockingScript: { toHex: () => 'other' }, satoshis: 2 },
          { lockingScript: revelationScript('revelation'), satoshis: 1 }
        ]
      }
      const signedTransaction = {
        id: jest.fn().mockReturnValue('ef'.repeat(32)),
        inputs: [
          { sourceTXID: '12'.repeat(32), sourceOutputIndex: 4 },
          {
            sourceTXID: MOCK_TXID,
            sourceOutputIndex: 1,
            unlockingScript: { toHex: () => 'unlockingScriptHex' }
          }
        ],
        outputs: []
      }
      Transaction.fromBEEF.mockReturnValue(sourceTransaction)
      Transaction.fromAtomicBEEF.mockReturnValue(signedTransaction)

      await identityClient.revokeCertificateRevelation(VALID_SERIAL)

      expect(walletMock.createAction).toHaveBeenCalledWith(
        expect.objectContaining({
          inputs: [expect.objectContaining({ outpoint: `${MOCK_TXID}.1` })]
        }),
        undefined
      )
      expect(walletMock.signAction).toHaveBeenCalledWith(
        expect.objectContaining({ spends: { 1: { unlockingScript: 'unlockingScriptHex' } } }),
        undefined
      )
    })

    it('rejects a signable transaction that substitutes the requested input', async () => {
      LookupResolver.mockImplementation(() => ({
        query: jest.fn().mockResolvedValue({
          type: 'output-list',
          outputs: [{ beef: [1, 2, 3], outputIndex: 0 }]
        })
      }))
      Transaction.fromAtomicBEEF.mockReturnValue({
        inputs: [{ sourceTXID: '12'.repeat(32), sourceOutputIndex: 0 }],
        outputs: []
      })

      await expect(identityClient.revokeCertificateRevelation(VALID_SERIAL)).rejects.toThrow(
        'does not contain the requested revelation input'
      )
      expect(walletMock.signAction).not.toHaveBeenCalled()
      expect(walletMock.abortAction).toHaveBeenCalledWith({ reference: 'ref' }, undefined)
    })

    it('rejects a signed transaction that substitutes the authorized template', async () => {
      LookupResolver.mockImplementation(() => ({
        query: jest.fn().mockResolvedValue({
          type: 'output-list',
          outputs: [{ beef: [1, 2, 3], outputIndex: 0 }]
        })
      }))
      const partial = {
        version: 1,
        lockTime: 0,
        id: jest.fn().mockReturnValue(MOCK_TXID),
        inputs: [{ sourceTXID: MOCK_TXID, sourceOutputIndex: 0 }],
        outputs: [{ satoshis: 1, lockingScript: { toHex: () => 'authorized' } }]
      }
      const substituted = {
        version: 1,
        lockTime: 0,
        id: jest.fn().mockReturnValue('ef'.repeat(32)),
        inputs: [
          {
            sourceTXID: MOCK_TXID,
            sourceOutputIndex: 0,
            unlockingScript: { toHex: () => 'unlockingScriptHex' }
          }
        ],
        outputs: [{ satoshis: 1, lockingScript: { toHex: () => 'substituted' } }]
      }
      Transaction.fromAtomicBEEF.mockReturnValueOnce(partial).mockReturnValueOnce(substituted)

      await expect(identityClient.revokeCertificateRevelation(VALID_SERIAL)).rejects.toThrow(
        'substituted an authorized output'
      )
      expect(walletMock.abortAction).toHaveBeenCalledWith({ reference: 'ref' }, undefined)
    })

    it('does not report success when the overlay rejects the revocation', async () => {
      LookupResolver.mockImplementation(() => ({
        query: jest.fn().mockResolvedValue({
          type: 'output-list',
          outputs: [{ beef: [1, 2, 3], outputIndex: 0 }]
        })
      }))
      SHIPBroadcaster.mockImplementation(() => ({
        broadcast: jest.fn().mockResolvedValue({
          status: 'error',
          code: 'ERR_ALL_HOSTS_REJECTED',
          description: 'rejected'
        })
      }))

      await expect(identityClient.revokeCertificateRevelation(VALID_SERIAL)).rejects.toThrow(
        'ERR_ALL_HOSTS_REJECTED'
      )
    })
  })

  // ─── constructor defaults ───────────────────────────────────────────────────

  describe('constructor', () => {
    it('defaults to WalletClient when no wallet provided', () => {
      // Should not throw — WalletClient is instantiated internally
      expect(() => new IdentityClient()).not.toThrow()
    })

    it('accepts an originator parameter', () => {
      const client = new IdentityClient(walletMock as WalletInterface, undefined, 'example.com')
      expect(client).toBeInstanceOf(IdentityClient)
    })
  })

  // ─── getContacts / saveContact / removeContact delegation ──────────────────

  describe('contact delegation methods', () => {
    it('getContacts delegates to contactsManager', async () => {
      const mockContactsManager = identityClient['contactsManager']
      const expected = [
        {
          name: 'Test',
          identityKey: 'key1',
          avatarURL: '',
          abbreviatedKey: '',
          badgeIconURL: '',
          badgeLabel: '',
          badgeClickURL: ''
        }
      ]
      mockContactsManager.getContacts = jest.fn().mockResolvedValue(expected)

      const result = await identityClient.getContacts('key1', true, 50)
      expect(mockContactsManager.getContacts).toHaveBeenCalledWith('key1', true, 50)
      expect(result).toBe(expected)
    })

    it('saveContact delegates to contactsManager', async () => {
      const mockContactsManager = identityClient['contactsManager']
      mockContactsManager.saveContact = jest.fn().mockResolvedValue(undefined)

      const contact = {
        name: 'Alice',
        identityKey: 'key1',
        avatarURL: '',
        abbreviatedKey: '',
        badgeIconURL: '',
        badgeLabel: '',
        badgeClickURL: ''
      }
      const metadata = { note: 'test' }
      await identityClient.saveContact(contact, metadata)

      expect(mockContactsManager.saveContact).toHaveBeenCalledWith(contact, metadata)
    })

    it('removeContact delegates to contactsManager', async () => {
      const mockContactsManager = identityClient['contactsManager']
      mockContactsManager.removeContact = jest.fn().mockResolvedValue(undefined)

      await identityClient.removeContact('key-to-remove')
      expect(mockContactsManager.removeContact).toHaveBeenCalledWith('key-to-remove')
    })
  })

  // ─── useContacts branches in resolveByIdentityKey / resolveByAttributes ─────

  // Shared helpers — extracted to keep new tests DRY (avoid Sonar duplication gate).
  const xCert = (subject: string, userName: string): any => ({
    type: KNOWN_IDENTITY_TYPES.xCert,
    subject,
    decryptedFields: { userName, profilePhoto: '' },
    certifierInfo: { name: 'CX', iconUrl: '' }
  })
  const emailCertOf = (subject: string, email: string): any => ({
    type: KNOWN_IDENTITY_TYPES.emailCert,
    subject,
    decryptedFields: { email },
    certifierInfo: { name: 'EC', iconUrl: '' }
  })
  const contactOf = (name: string, identityKey: string): any => ({
    name,
    identityKey,
    avatarURL: '',
    abbreviatedKey: '',
    badgeIconURL: '',
    badgeLabel: '',
    badgeClickURL: ''
  })
  const stubDiscoveryByKey = (contacts: any[], certificates: any[]): void => {
    identityClient['contactsManager'].getContacts = jest.fn().mockResolvedValue(contacts)
    walletMock.discoverByIdentityKey = jest.fn().mockResolvedValue({ certificates })
  }
  const stubDiscoveryByAttr = (contacts: any[], certificates: any[]): void => {
    identityClient['contactsManager'].getContacts = jest.fn().mockResolvedValue(contacts)
    walletMock.discoverByAttributes = jest.fn().mockResolvedValue({ certificates })
  }

  describe('resolveByIdentityKey with useContacts opt-in', () => {
    it('contacts miss falls through to overlay (sequential)', async () => {
      stubDiscoveryByKey([], [xCert('k1', 'XUser')])
      const result = await identityClient.resolveByIdentityKey(
        { identityKey: 'k1' },
        { useContacts: true }
      )
      expect(walletMock.discoverByIdentityKey).toHaveBeenCalled()
      expect(result[0].name).toBe('XUser')
    })

    it('parallel mode returns contact on hit even though overlay runs', async () => {
      const contact = contactOf('Cached Alice', 'k2')
      stubDiscoveryByKey([contact], [])
      const result = await identityClient.resolveByIdentityKey(
        { identityKey: 'k2' },
        { useContacts: true, parallel: true }
      )
      expect(walletMock.discoverByIdentityKey).toHaveBeenCalled()
      expect(result).toEqual([contact])
    })

    it('parallel mode contacts miss returns parsed overlay results', async () => {
      stubDiscoveryByKey([], [xCert('k3', 'XOnly')])
      const result = await identityClient.resolveByIdentityKey(
        { identityKey: 'k3' },
        { useContacts: true, parallel: true }
      )
      expect(result[0].name).toBe('XOnly')
    })

    it('legacy boolean opt-in (true) consults contacts', async () => {
      stubDiscoveryByKey([contactOf('Legacy True', 'k4')], [])
      const result = await identityClient.resolveByIdentityKey({ identityKey: 'k4' }, true)
      expect(result[0].name).toBe('Legacy True')
      expect(walletMock.discoverByIdentityKey).not.toHaveBeenCalled()
    })

    it('overrideWithContacts legacy alias takes precedence over useContacts', async () => {
      stubDiscoveryByKey([contactOf('Override Wins', 'k5')], [])
      const result = await identityClient.resolveByIdentityKey(
        { identityKey: 'k5' },
        { useContacts: false, overrideWithContacts: true }
      )
      expect(result[0].name).toBe('Override Wins')
    })
  })

  describe('resolveByAttributes with useContacts opt-in', () => {
    it('contacts no-match falls through to overlay with contact overrides applied', async () => {
      stubDiscoveryByAttr(
        [contactOf('Override Alice', 'k-over')],
        [emailCertOf('k-over', 'alice@example.com')]
      )
      const result = await identityClient.resolveByAttributes(
        { attributes: { email: 'alice@example.com' } },
        { useContacts: true }
      )
      expect(result[0].name).toBe('Override Alice')
    })

    it('contacts empty + overlay miss returns empty', async () => {
      stubDiscoveryByAttr([], [])
      const result = await identityClient.resolveByAttributes(
        { attributes: { email: 'nobody@example.com' } },
        { useContacts: true }
      )
      expect(result).toEqual([])
    })

    it('parallel mode with no contacts parses overlay only', async () => {
      stubDiscoveryByAttr([], [emailCertOf('no-contact-key', 'lone@example.com')])
      const result = await identityClient.resolveByAttributes(
        { attributes: { email: 'lone@example.com' } },
        { useContacts: true, parallel: true }
      )
      expect(result[0].name).toBe('lone@example.com')
    })

    it('parallel mode with contacts applies overrides on overlay results', async () => {
      stubDiscoveryByAttr(
        [contactOf('Parallel Contact', 'pk')],
        [emailCertOf('pk', 'p@example.com')]
      )
      const result = await identityClient.resolveByAttributes(
        { attributes: { email: 'p@example.com' } },
        { useContacts: true, parallel: true }
      )
      expect(result[0].name).toBe('Parallel Contact')
    })

    it('matchContactsByAttributes ignores non-string attribute values', async () => {
      stubDiscoveryByAttr([contactOf('X', 'kkkk')], [])
      const result = await identityClient.resolveByAttributes(
        { attributes: { count: 5 as unknown as string } },
        { useContacts: true }
      )
      // No string-valued attrs → matchContactsByAttributes returns [] → overlay path
      expect(walletMock.discoverByAttributes).toHaveBeenCalled()
      expect(result).toEqual([])
    })
  })

  describe('parseIdentities batched path', () => {
    it('yields to event loop when batch > PARSE_BATCH_SIZE', async () => {
      const certs = Array.from({ length: 64 }, (_, i) => xCert(`subject-${i}`, `user-${i}`))
      const result = await IdentityClient.parseIdentities(certs)
      expect(result).toHaveLength(64)
      expect(result[63].name).toBe('user-63')
    })

    it('parseIdentitiesWithOverrides batches with overrides applied', async () => {
      const certs = Array.from({ length: 50 }, (_, i) => xCert(`subject-${i}`, `user-${i}`))
      const overrideMap = new Map<string, any>([
        ['subject-5', contactOf('Override 5', 'subject-5')],
        ['subject-40', contactOf('Override 40', 'subject-40')]
      ])
      const result = await IdentityClient.parseIdentitiesWithOverrides(certs, overrideMap)
      expect(result[5].name).toBe('Override 5')
      expect(result[40].name).toBe('Override 40')
      expect(result[6].name).toBe('user-6')
    })
  })

  describe('yieldToEventLoop scheduler.yield path', () => {
    const origScheduler = (globalThis as any).scheduler
    afterEach(() => {
      ;(globalThis as any).scheduler = origScheduler
    })

    it('uses scheduler.yield when available', async () => {
      const yieldFn = jest.fn().mockResolvedValue(undefined)
      ;(globalThis as any).scheduler = { yield: yieldFn }
      const certs = Array.from({ length: 64 }, (_, i) => xCert(`s-${i}`, `u-${i}`))
      await IdentityClient.parseIdentities(certs)
      expect(yieldFn).toHaveBeenCalled()
    })
  })
})
