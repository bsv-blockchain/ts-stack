import { MasterCertificate } from '../MasterCertificate.js'
import { CompletedProtoWallet } from './CompletedProtoWallet.js'
import PrivateKey from '../../../primitives/PrivateKey.js'
import SymmetricKey from '../../../primitives/SymmetricKey.js'
import * as Utils from '../../../primitives/utils.js'

const subjectWallet = new CompletedProtoWallet(new PrivateKey(21))
const certifierWallet = new CompletedProtoWallet(new PrivateKey(22))
const certificateType = Utils.toBase64(Array(32).fill(1))

describe('MasterCertificate security boundaries', () => {
  it('owns constructor field and keyring records', async () => {
    const subject = (await subjectWallet.getPublicKey({ identityKey: true })).publicKey
    const certifier = (await certifierWallet.getPublicKey({ identityKey: true })).publicKey
    const { certificateFields, masterKeyring } = await MasterCertificate.createCertificateFields(
      certifierWallet,
      subject,
      { name: 'Alice' }
    )
    const certificate = new MasterCertificate(
      certificateType,
      Utils.toBase64(Array(32).fill(2)),
      subject,
      certifier,
      '00'.repeat(32),
      certificateFields,
      masterKeyring
    )
    const encryptedName = certificate.fields.name
    const encryptedKey = certificate.masterKeyring.name

    certificateFields.name = Utils.toBase64([1])
    masterKeyring.name = Utils.toBase64([2])

    expect(certificate.fields.name).toBe(encryptedName)
    expect(certificate.masterKeyring.name).toBe(encryptedKey)
    expect(Object.getPrototypeOf(certificate.fields)).toBeNull()
    expect(Object.getPrototypeOf(certificate.masterKeyring)).toBeNull()
  })

  it('snapshots plaintext before awaiting wallet encryption', async () => {
    const subject = (await subjectWallet.getPublicKey({ identityKey: true })).publicKey
    const plaintextFields = { name: 'Alice', role: 'operator' }
    const originalEncrypt = certifierWallet.encrypt.bind(certifierWallet)
    let release!: () => void
    let encryptionStarted!: () => void
    const encryptionStartedPromise = new Promise<void>(resolve => {
      encryptionStarted = resolve
    })
    const releasePromise = new Promise<void>(resolve => {
      release = resolve
    })
    const spy = jest
      .spyOn(certifierWallet, 'encrypt')
      .mockImplementation(async (args, originator) => {
        encryptionStarted()
        await releasePromise
        return await originalEncrypt(args, originator)
      })

    const creating = MasterCertificate.createCertificateFields(
      certifierWallet,
      subject,
      plaintextFields
    )
    await encryptionStartedPromise
    plaintextFields.role = 'administrator'
    release()
    const created = await creating
    spy.mockRestore()

    await expect(
      MasterCertificate.decryptFields(
        subjectWallet,
        created.masterKeyring,
        created.certificateFields,
        (await certifierWallet.getPublicKey({ identityKey: true })).publicKey
      )
    ).resolves.toEqual({ name: 'Alice', role: 'operator' })
  })

  it('rejects accessors, oversized plaintext, duplicate reveals, and sparse reveal arrays', async () => {
    const accessorFields = Object.create(null) as Record<string, string>
    Object.defineProperty(accessorFields, 'name', {
      enumerable: true,
      get: () => 'Alice'
    })
    await expect(
      MasterCertificate.createCertificateFields(certifierWallet, 'self', accessorFields)
    ).rejects.toThrow('own string data property')
    await expect(
      MasterCertificate.createCertificateFields(certifierWallet, 'self', {
        name: 'x'.repeat(64 * 1024 + 1)
      })
    ).rejects.toThrow('exceeds the maximum')

    const sparse: string[] = []
    sparse.length = 1
    await expect(
      MasterCertificate.createKeyringForVerifier(
        subjectWallet,
        'self',
        'self',
        {},
        sparse,
        {},
        Utils.toBase64(Array(32).fill(2))
      )
    ).rejects.toThrow('dense array')
    await expect(
      MasterCertificate.createKeyringForVerifier(
        subjectWallet,
        'self',
        'self',
        {},
        ['name', 'name'],
        {},
        Utils.toBase64(Array(32).fill(2))
      )
    ).rejects.toThrow('duplicate field')
  })

  it('restores leading zero bytes omitted by legacy revelation-key encodings', async () => {
    const encryptedField = new SymmetricKey(1).encrypt(Utils.toArray('Alice', 'utf8')) as number[]
    const wallet = {
      decrypt: jest.fn(async () => ({ plaintext: [1] }))
    }

    await expect(
      MasterCertificate.decryptField(
        wallet as never,
        { name: Utils.toBase64([1]) },
        'name',
        Utils.toBase64(encryptedField),
        'self'
      )
    ).resolves.toEqual({
      fieldRevelationKey: [...Array(31).fill(0), 1],
      decryptedFieldValue: 'Alice'
    })
  })
})
