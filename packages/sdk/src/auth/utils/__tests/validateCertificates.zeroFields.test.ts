import { MasterCertificate } from '../../certificates/MasterCertificate.js'
import { VerifiableCertificate } from '../../certificates/VerifiableCertificate.js'
import { CompletedProtoWallet } from '../../certificates/__tests/CompletedProtoWallet.js'
import { PrivateKey, Utils } from '../../../primitives/index.js'
import { AuthMessage, RequestedCertificateSet } from '../../types.js'
import { validateCertificates } from '../validateCertificates.js'
import { getVerifiableCertificates } from '../getVerifiableCertificates.js'
import { WalletInterface } from '../../../wallet/Wallet.interfaces.js'

// Crypto is real. Only certificate storage and the wallet permission decision
// are doubles; this fixture does not establish wallet-toolbox/DCAP integration.
async function fixture() {
  const issuer = new CompletedProtoWallet(new PrivateKey(71))
  const holder = new CompletedProtoWallet(new PrivateKey(72))
  const verifier = new CompletedProtoWallet(new PrivateKey(73))
  const type = Utils.toBase64(Array.from({ length: 32 }, () => 7))
  const subject = (await holder.getPublicKey({ identityKey: true })).publicKey
  const verifierIdentity = (await verifier.getPublicKey({ identityKey: true })).publicKey
  const master = await MasterCertificate.issueCertificateForSubject(
    issuer,
    subject,
    { name: 'Synthetic holder', email: 'holder@example.invalid' },
    type,
    async () => `${'12'.repeat(32)}.0`
  )
  if (master.signature === undefined) throw new Error('Expected an issuer-signed fixture')
  const signedMaster = Object.assign(master, { signature: master.signature })
  const certificate = VerifiableCertificate.fromCertificate(signedMaster, {})
  const requested: RequestedCertificateSet = {
    certifiers: [master.certifier],
    types: { [type]: [] }
  }
  const message: AuthMessage = {
    version: '0.1',
    messageType: 'initialResponse',
    identityKey: subject,
    certificates: [certificate]
  }
  const decrypt = jest.spyOn(verifier, 'decrypt')
  return {
    issuer,
    holder,
    verifier,
    verifierIdentity,
    master: signedMaster,
    certificate,
    requested,
    message,
    decrypt
  }
}

describe('validateCertificates with an explicit zero-field request and real signatures', () => {
  afterEach(() => jest.restoreAllMocks())

  it.each(['empty', 'omitted', 'null'] as const)(
    'accepts a signed core with an %s keyring without decrypting',
    async form => {
      const f = await fixture()
      if (form === 'omitted') Reflect.deleteProperty(f.certificate, 'keyring')
      if (form === 'null') Reflect.set(f.certificate, 'keyring', null)
      const decryptFields = jest.spyOn(VerifiableCertificate.prototype, 'decryptFields')
      await expect(
        validateCertificates(f.verifier, f.message, f.requested, undefined, true)
      ).resolves.toBeUndefined()
      expect(decryptFields).not.toHaveBeenCalled()
      expect(f.decrypt).not.toHaveBeenCalled()
      expect(f.certificate.fields).toEqual(f.master.fields)
      expect(f.certificate.fields.name).not.toBe('Synthetic holder')
    }
  )

  it.each([[], '', 0, false])('rejects a malformed zero-field keyring: %p', async keyring => {
    const f = await fixture()
    Reflect.set(f.certificate, 'keyring', keyring)
    await expect(
      validateCertificates(f.verifier, f.message, f.requested, undefined, true)
    ).rejects.toThrow()
    expect(f.decrypt).not.toHaveBeenCalled()
  })

  it('requires an actual empty field array, not an empty string', async () => {
    const f = await fixture()
    Reflect.set(f.requested.types, f.master.type, '')
    await expect(
      validateCertificates(f.verifier, f.message, f.requested, undefined, true)
    ).rejects.toThrow()
    expect(f.decrypt).not.toHaveBeenCalled()
  })

  it('retains the public decryptFields requirement for a nonempty keyring', async () => {
    const f = await fixture()
    await expect(f.certificate.decryptFields(f.verifier)).rejects.toThrow('A keyring is required')
    expect(f.decrypt).not.toHaveBeenCalled()
  })

  it.each([
    'wrong issuer',
    'wrong type',
    'wrong subject',
    'forged core',
    'forged signature',
    'missing signature'
  ])('rejects %s before the zero-field path', async failure => {
    const f = await fixture()
    if (failure === 'wrong issuer') f.requested.certifiers = [f.verifierIdentity]
    if (failure === 'wrong type')
      f.requested.types = { [Utils.toBase64(Array.from({ length: 32 }, () => 8))]: [] }
    if (failure === 'wrong subject') f.message.identityKey = f.verifierIdentity
    if (failure === 'forged core') f.certificate.fields.name = Utils.toBase64([1, 2, 3])
    if (failure === 'forged signature') {
      const signature = Utils.toArray(f.certificate.signature ?? '', 'hex')
      signature[signature.length - 1] ^= 1
      f.certificate.signature = Utils.toHex(signature)
    }
    if (failure === 'missing signature') f.certificate.signature = undefined
    const decryptFields = jest.spyOn(VerifiableCertificate.prototype, 'decryptFields')
    await expect(
      validateCertificates(f.verifier, f.message, f.requested, undefined, true)
    ).rejects.toThrow()
    expect(decryptFields).not.toHaveBeenCalled()
    expect(f.decrypt).not.toHaveBeenCalled()
  })

  it('rejects even a usable extra keyring entry for a zero-field request without decrypting', async () => {
    const f = await fixture()
    f.certificate.keyring = await MasterCertificate.createKeyringForVerifier(
      f.holder,
      f.master.certifier,
      f.verifierIdentity,
      f.master.fields,
      ['name'],
      f.master.masterKeyring,
      f.master.serialNumber
    )
    await expect(
      validateCertificates(f.verifier, f.message, f.requested, undefined, true)
    ).rejects.toThrow('Unexpected keyring')
    expect(f.decrypt).not.toHaveBeenCalled()
  })

  it.each(['nonempty request', 'no request', 'unmatched request'])(
    'rejects an empty keyring with %s',
    async mode => {
      const f = await fixture()
      let requested: RequestedCertificateSet | undefined = f.requested
      if (mode === 'nonempty request') requested.types[f.master.type] = ['name']
      if (mode === 'no request') {
        requested = undefined
        f.message.requestedCertificates = f.requested
      }
      if (mode === 'unmatched request')
        requested = { certifiers: f.requested.certifiers, types: {} }
      await expect(
        validateCertificates(f.verifier, f.message, requested, undefined, true)
      ).rejects.toThrow()
      expect(f.decrypt).not.toHaveBeenCalled()
    }
  )

  it.each([true, false])(
    'preserves real nonempty disclosure with requested=%s',
    async hasRequest => {
      const f = await fixture()
      f.requested.types[f.master.type] = ['name']
      f.certificate.keyring = await MasterCertificate.createKeyringForVerifier(
        f.holder,
        f.master.certifier,
        f.verifierIdentity,
        f.master.fields,
        ['name'],
        f.master.masterKeyring,
        f.master.serialNumber
      )
      await expect(
        validateCertificates(f.verifier, f.message, hasRequest ? f.requested : undefined)
      ).resolves.toBeUndefined()
      expect(f.decrypt).toHaveBeenCalledTimes(1)
      await expect(f.certificate.decryptFields(f.verifier)).resolves.toEqual({
        name: 'Synthetic holder'
      })
    }
  )

  it('rejects a mixed batch when a later certificate has an invalid core', async () => {
    const f = await fixture()
    const invalid = VerifiableCertificate.fromCertificate(f.master, {})
    invalid.fields = { ...invalid.fields, name: Utils.toBase64([1]) }
    f.message.certificates?.push(invalid)
    await expect(
      validateCertificates(f.verifier, f.message, f.requested, undefined, true)
    ).rejects.toThrow()
    expect(f.decrypt).not.toHaveBeenCalled()
  })
})

describe('validateCertificates allowZeroFields argument', () => {
  afterEach(() => jest.restoreAllMocks())

  it.each(['omitted', 'false'] as const)(
    'keeps the nonempty path when allowZeroFields is %s',
    async mode => {
      const f = await fixture()
      const result =
        mode === 'omitted'
          ? validateCertificates(f.verifier, f.message, f.requested)
          : validateCertificates(f.verifier, f.message, f.requested, undefined, false)
      await expect(result).rejects.toThrow('A keyring is required')
      expect(f.decrypt).not.toHaveBeenCalled()
    }
  )

  it('accepts the zero-field proof only when allowZeroFields is true', async () => {
    const f = await fixture()
    await expect(
      validateCertificates(f.verifier, f.message, f.requested, undefined, true)
    ).resolves.toBeUndefined()
    expect(f.decrypt).not.toHaveBeenCalled()
  })
})

describe('zero-field holder proof permission seam', () => {
  afterEach(() => jest.restoreAllMocks())

  it.each([false, true])(
    'calls the exact verifier/type/empty-fields proof, permission denied=%s',
    async denied => {
      const f = await fixture()
      const proveCertificate = jest.fn<
        ReturnType<WalletInterface['proveCertificate']>,
        Parameters<WalletInterface['proveCertificate']>
      >(async args => {
        if (denied) throw new Error('fixture permission denied')
        return {
          keyringForVerifier: await MasterCertificate.createKeyringForVerifier(
            f.holder,
            f.master.certifier,
            args.verifier,
            f.master.fields,
            args.fieldsToReveal,
            f.master.masterKeyring,
            f.master.serialNumber
          )
        }
      })
      const wallet: WalletInterface = Object.assign(f.holder, {
        listCertificates: jest.fn(async () => ({ totalCertificates: 1, certificates: [f.master] })),
        proveCertificate
      })
      const result = getVerifiableCertificates(
        wallet,
        f.requested,
        f.verifierIdentity,
        'fixture.example'
      )
      if (denied) {
        await expect(result).rejects.toThrow('fixture permission denied')
      } else {
        await expect(result).resolves.toEqual([f.certificate])
      }
      expect(proveCertificate).toHaveBeenCalledTimes(1)
      expect(proveCertificate).toHaveBeenCalledWith(
        {
          certificate: f.master,
          fieldsToReveal: [],
          verifier: f.verifierIdentity
        },
        'fixture.example'
      )
    }
  )
})
