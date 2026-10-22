import historicalVectors from '../../../../../../specs/wallet/fixtures/legacy-certificates.json'
import { Peer } from '../../../auth/Peer'
import { MasterCertificate } from '../../../auth/certificates/MasterCertificate'
import type { AuthMessage, Transport } from '../../../auth/types'
import Certificate from '../../../auth/certificates/Certificate'
import ProtoWallet from '../../ProtoWallet'
import PrivateKey from '../../../primitives/PrivateKey'
import {
  Writer,
  ReaderUint8Array,
  WriterUint8Array,
  toArray,
  toBase64,
  toHex
} from '../../../primitives/utils'
import { validateWalletResult } from '../../WalletResultValidation'
import {
  validateAcquireIssuanceCertificateArgs,
  validateAcquireDirectCertificateArgs
} from '../../validationHelpers'
import { assertRequestedCertificateSet } from '../../../auth/AuthMessageValidation'
import WalletWireTransceiver from '../WalletWireTransceiver'
import WalletWireProcessor from '../WalletWireProcessor'
import type { WalletInterface } from '../../Wallet.interfaces'
import {
  CERTIFICATE_TYPE_MARKER,
  CERTIFICATE_TYPE_FIELD,
  encodeWireCertificate,
  decodeWireCertificate,
  readCertificateType,
  writeCertificateType
} from '../CertificateWireCompatibility'

const key = new PrivateKey(7)
const pub = key.toPublicKey().toString()
const serial = toBase64(Array.from({ length: 32 }, () => 2))
const typeOf = (length: number) => toBase64(Array.from({ length: length }, () => 3))
const signature = '3006020101020101'
const makeCertificate = (type = typeOf(16), fields = { name: 'ZW5j' }) =>
  new Certificate(type, serial, pub, pub, '00'.repeat(32) + '.0', fields, signature)

// Independent pre-2.8 serializer: no new production codec or signing serializer.
function historicalPreimage(certificate: Certificate): number[] {
  const writer = new Writer()
  writer.write(toArray(certificate.type, 'base64'))
  writer.write(toArray(certificate.serialNumber, 'base64'))
  writer.write(toArray(certificate.subject, 'hex'))
  writer.write(toArray(certificate.certifier, 'hex'))
  writer.write(Array.from({ length: 32 }, () => 0))
  writer.writeVarIntNum(0)
  const names = Object.keys(certificate.fields).sort((a, b) => a.localeCompare(b))
  writer.writeVarIntNum(names.length)
  for (const name of names) {
    const nameBytes = toArray(name, 'utf8')
    const valueBytes = toArray(certificate.fields[name], 'utf8')
    writer.writeVarIntNum(nameBytes.length)
    writer.write(nameBytes)
    writer.writeVarIntNum(valueBytes.length)
    writer.write(valueBytes)
  }
  return writer.toArray()
}

async function signHistorical(certificate: Certificate): Promise<void> {
  const result = await new ProtoWallet(key).createSignature({
    data: historicalPreimage(certificate),
    protocolID: [2, 'certificate signature'],
    keyID: `${certificate.type} ${serial}`
  })
  certificate.signature = toHex(result.signature)
}

describe('legacy certificate transport and signatures', () => {
  test.each([1, 16, 31, 32, 33, 39, 128])(
    '%i-byte types preserve the historical signed object',
    async length => {
      const certificate = makeCertificate(typeOf(length))
      await signHistorical(certificate)
      await expect(certificate.verify()).resolves.toBe(true)
      const binary = encodeWireCertificate(certificate, true)
      const parsed = decodeWireCertificate(binary, true)
      expect(parsed).toEqual(certificate)
      await expect(parsed.verify()).resolves.toBe(true)
      expect(certificate.fields).toEqual({ name: 'ZW5j' })
      parsed.fields.name = 'dGFtcGVy'
      await expect(parsed.verify()).resolves.toBe(false)
      if (length !== 32) expect(() => certificate.toBinary()).toThrow()
    }
  )

  test.each([typeOf(16), CERTIFICATE_TYPE_MARKER])(
    'preserves a genuine field occupying the transport key (%s)',
    async type => {
      const certificate = makeCertificate(type, {
        name: 'ZW5j',
        [CERTIFICATE_TYPE_FIELD]: 'c2lnbmVk'
      })
      await signHistorical(certificate)
      const parsed = decodeWireCertificate(encodeWireCertificate(certificate, true), true)
      expect(parsed).toEqual(certificate)
      await expect(parsed.verify()).resolves.toBe(true)
    }
  )

  test('ordinary bytes and marker-valued ordinary types stay literal outside the profile', () => {
    for (const type of [typeOf(32), CERTIFICATE_TYPE_MARKER]) {
      const cert = makeCertificate(type)
      expect(encodeWireCertificate(cert, false)).toEqual(cert.toBinary())
      expect(decodeWireCertificate(cert.toBinary(), false)).toEqual(cert)
    }
    const cert = makeCertificate(typeOf(32))
    expect(encodeWireCertificate(cert, true)).toEqual(cert.toBinary())
  })

  test('transported type tampering cannot authenticate under the original signature', async () => {
    const certificate = makeCertificate()
    await signHistorical(certificate)
    const transport = Certificate.fromBinary(encodeWireCertificate(certificate, true))
    transport.fields[CERTIFICATE_TYPE_FIELD] = toBase64(
      toArray(JSON.stringify([1, typeOf(39), null]), 'utf8')
    )
    await expect(decodeWireCertificate(transport.toBinary(), true).verify()).resolves.toBe(false)
  })

  test.each(['', typeOf(129), typeOf(130), 'AQ', 'AR==', ' AQ=='])(
    'rejects invalid existing type %s even if independently signed',
    async type => {
      const cert = makeCertificate(type)
      await signHistorical(cert)
      await expect(cert.verify()).resolves.toBe(false)
      expect(() => encodeWireCertificate(cert, true)).toThrow()
    }
  )

  test.each([
    null,
    [],
    [2, typeOf(16), null],
    [1, '', null],
    [1, typeOf(32), null],
    [1, typeOf(16), {}]
  ])('rejects malformed metadata %j', metadata => {
    const cert = makeCertificate(CERTIFICATE_TYPE_MARKER, {
      [CERTIFICATE_TYPE_FIELD]: toBase64(toArray(JSON.stringify(metadata), 'utf8'))
    })
    expect(() => decodeWireCertificate(cert.toBinary(), true)).toThrow()
  })

  test('requires metadata and rejects duplicate fields, truncation and trailing bytes', () => {
    expect(() =>
      decodeWireCertificate(makeCertificate(CERTIFICATE_TYPE_MARKER).toBinary(), true)
    ).toThrow(/Missing/)
    const bytes = encodeWireCertificate(makeCertificate(), true)
    expect(() => decodeWireCertificate(bytes.slice(0, 100), true)).toThrow()
    expect(() => decodeWireCertificate([...bytes, 0], true)).toThrow()
  })

  test.each([typeOf(1), typeOf(32), typeOf(39), typeOf(128), CERTIFICATE_TYPE_MARKER])(
    'type slot restores exact original %s',
    type => {
      const writer = new WriterUint8Array()
      writeCertificateType(writer, type, true)
      const reader = new ReaderUint8Array(writer.toUint8Array())
      expect(readCertificateType(reader, true)).toBe(type)
      expect(reader.eof()).toBe(true)
      if (type === typeOf(32))
        expect(Array.from(writer.toUint8Array())).toEqual(toArray(type, 'base64'))
    }
  )

  test.each([0, 129, 1024])('rejects escaped length %i before consuming the payload', length => {
    const writer = new WriterUint8Array()
    writer.write(toArray(CERTIFICATE_TYPE_MARKER, 'base64'))
    writer.writeVarIntNum(length)
    expect(() => readCertificateType(new ReaderUint8Array(writer.toUint8Array()), true)).toThrow()
  })

  test('issuance, direct acquisition and signing stay strict', async () => {
    for (const type of [typeOf(1), typeOf(39)]) {
      expect(() =>
        validateAcquireIssuanceCertificateArgs({
          type,
          certifier: pub,
          acquisitionProtocol: 'issuance',
          fields: {},
          certifierUrl: 'https://example.com'
        })
      ).toThrow()
      expect(() =>
        validateAcquireDirectCertificateArgs({
          ...makeCertificate(type),
          acquisitionProtocol: 'direct',
          keyringRevealer: 'certifier',
          keyringForSubject: { name: 'a2V5' }
        } as any)
      ).toThrow()
      const cert = makeCertificate(type)
      cert.signature = undefined
      await expect(cert.sign(new ProtoWallet(key))).rejects.toThrow()
      expect(() =>
        validateWalletResult('acquireCertificate', { ...makeCertificate(type) })
      ).toThrow()
    }
  })

  test.each([1, 16, 39, 128])(
    'authentication requested set permits %i-byte legacy types',
    length => {
      expect(() =>
        assertRequestedCertificateSet({ certifiers: [pub], types: { [typeOf(length)]: ['name'] } })
      ).not.toThrow()
    }
  )
})

describe('binary substrate compatibility profile', () => {
  const setup = () => {
    const certificates = [
      makeCertificate(typeOf(32)),
      makeCertificate(typeOf(16)),
      makeCertificate(typeOf(39))
    ]
    const list = jest.fn(async (args: any) => {
      const matches = certificates.filter(
        cert => args.types.length === 0 || args.types.includes(cert.type)
      )
      return {
        totalCertificates: matches.length,
        certificates: matches
          .map(cert => ({ ...cert }))
          .slice(args.offset ?? 0, (args.offset ?? 0) + (args.limit ?? 10))
      }
    })
    const prove = jest.fn(async () => ({ keyringForVerifier: { name: 'a2V5' } }))
    const relinquish = jest.fn(async () => ({ relinquished: true as const }))
    const wallet = {
      listCertificates: list,
      proveCertificate: prove,
      relinquishCertificate: relinquish
    } as unknown as WalletInterface
    const processor = new WalletWireProcessor(wallet)
    const frames: number[][] = []
    const client = new WalletWireTransceiver({
      transmitToWallet: async message => {
        frames.push(message)
        return await processor.transmitToWallet(message)
      }
    })
    return { certificates, list, prove, relinquish, processor, client, frames }
  }

  test('unfiltered listing returns legacy objects, keyrings and original totals', async () => {
    const { client, certificates, list, frames } = setup()
    certificates[1].fields[CERTIFICATE_TYPE_FIELD] = 'b3JpZ2luYWw='
    const result = await client.listCertificates({ types: [], certifiers: [] }, 'example.com')
    expect(result).toEqual({
      totalCertificates: 3,
      certificates: certificates.map(cert => ({ ...cert, keyring: {}, verifier: undefined }))
    })
    expect(list).toHaveBeenCalledWith(expect.objectContaining({ types: [] }), 'example.com')
    expect(frames.map(frame => frame[0])).toEqual([29, 29])
    expect(list).toHaveBeenCalledTimes(1) // probe never invokes a BRC-100 wallet method
  })

  test('legacy filtering, proof and relinquishment receive the original types', async () => {
    const { client, certificates, prove, relinquish } = setup()
    const cert = certificates[1]
    expect(
      (await client.listCertificates({ types: [cert.type], certifiers: [] })).certificates
    ).toHaveLength(1)
    await expect(
      client.proveCertificate({ certificate: { ...cert }, fieldsToReveal: ['name'], verifier: pub })
    ).resolves.toEqual({ keyringForVerifier: { name: 'a2V5' } })
    expect(prove).toHaveBeenCalledWith(
      expect.objectContaining({
        certificate: expect.objectContaining({ type: cert.type, fields: cert.fields })
      }),
      ''
    )
    await client.relinquishCertificate({ type: cert.type, serialNumber: serial, certifier: pub })
    expect(relinquish).toHaveBeenCalledWith(
      { type: cert.type, serialNumber: serial, certifier: pub },
      ''
    )
  })

  test('canonical filtered listing and relinquishment retain the original frame IDs', async () => {
    const { client, frames } = setup()
    await client.listCertificates({ types: [typeOf(32)], certifiers: [] })
    await client.relinquishCertificate({ type: typeOf(32), serialNumber: serial, certifier: pub })
    expect(frames.map(frame => frame[0])).toEqual([18, 20])
  })

  test('parallel normal/profile requests do not share parser state', async () => {
    const { client } = setup()
    const results = await Promise.all([
      client.listCertificates({ types: [], certifiers: [] }),
      client.listCertificates({ types: [typeOf(32)], certifiers: [] })
    ])
    expect(results.map(result => result.certificates.length)).toEqual([3, 1])
  })

  test.each([
    [29, 0, 0, 2],
    [29, 0, 2, 1],
    [29, 0, 1, 1, 17],
    [29, 0, 1, 1, 29],
    [29, 0, 0, 1, 0]
  ])('rejects invalid envelope %j before invoking wallet', async (...frame: number[]) => {
    const { processor, list, relinquish, prove } = setup()
    expect((await processor.transmitToWallet(frame))[0]).not.toBe(0)
    expect(list).not.toHaveBeenCalled()
    expect(relinquish).not.toHaveBeenCalled()
    expect(prove).not.toHaveBeenCalled()
  })

  test('does not downgrade malformed capability responses or retry a mutation', async () => {
    const transmit = jest.fn(async () => [0, 99])
    const client = new WalletWireTransceiver({ transmitToWallet: transmit })
    await expect(
      client.relinquishCertificate({ type: typeOf(16), serialNumber: serial, certifier: pub })
    ).rejects.toThrow(/capability/)
    expect(transmit).toHaveBeenCalledTimes(1)
  })
})

test.each([16, 39])(
  'real BRC-103 authentication exchanges a %i-byte historical certificate',
  async length => {
    const holder = new ProtoWallet(new PrivateKey(11))
    const verifier = new ProtoWallet(new PrivateKey(13))
    const holderPub = (await holder.getPublicKey({ identityKey: true })).publicKey
    const { certificateFields, masterKeyring } = await MasterCertificate.createCertificateFields(
      new ProtoWallet(key),
      holderPub,
      { name: 'Alice' }
    )
    const certificate = new Certificate(
      typeOf(length),
      serial,
      holderPub,
      pub,
      '00'.repeat(32) + '.0',
      certificateFields
    )
    await signHistorical(certificate)
    const holderWallet = Object.assign(holder, {
      listCertificates: async () => ({ totalCertificates: 1, certificates: [{ ...certificate }] }),
      proveCertificate: async (args: any) => ({
        keyringForVerifier: await MasterCertificate.createKeyringForVerifier(
          holder,
          pub,
          args.verifier,
          certificateFields,
          args.fieldsToReveal,
          masterKeyring,
          serial
        )
      })
    }) as unknown as WalletInterface
    const holderClient = new WalletWireTransceiver(new WalletWireProcessor(holderWallet))
    const callbacks: Array<(message: AuthMessage) => Promise<void>> = []
    const errors: unknown[] = []
    const transport = (index: number): Transport => ({
      onData: async callback => {
        callbacks[index] = callback
      },
      send: async message => {
        queueMicrotask(() => {
          void callbacks[1 - index](message).catch(error => errors.push(error))
        })
      }
    })
    const holderPeer = new Peer(holderClient, transport(0))
    const verifierPeer = new Peer(verifier as unknown as WalletInterface, transport(1), {
      certifiers: [pub],
      types: { [certificate.type]: ['name'] }
    })
    const received = new Promise<Certificate[]>(resolve => {
      verifierPeer.listenForCertificatesReceived((_sender, certificates) => resolve(certificates))
    })
    await Promise.all([holderPeer.ready, verifierPeer.ready])
    await verifierPeer.toPeer([1], holderPub)
    const certificates = await received
    expect(certificates).toHaveLength(1)
    expect(certificates[0].type).toBe(certificate.type)
    await expect(certificates[0].verify()).resolves.toBe(true)
    expect(errors).toEqual([])
  },
  10000
)

test('restoring displaced metadata preserves stable collation ties', async () => {
  const name = CERTIFICATE_TYPE_FIELD + '\u034f'
  const certificate = makeCertificate(typeOf(16), {
    [CERTIFICATE_TYPE_FIELD]: 'b25l',
    [name]: 'dHdv'
  })
  await signHistorical(certificate)
  const parsed = decodeWireCertificate(encodeWireCertificate(certificate, true), true)
  await expect(parsed.verify()).resolves.toBe(true)
})

test('a pending capability probe cannot substitute a relinquishment reference', async () => {
  let release!: (response: number[]) => void
  const probe = new Promise<number[]>(resolve => {
    release = resolve
  })
  const requests: number[][] = []
  const transmitToWallet = jest.fn(async (frame: number[]) => {
    requests.push(frame)
    return requests.length === 1 ? await probe : [0]
  })
  const client = new WalletWireTransceiver({ transmitToWallet })
  const args = { type: typeOf(16), serialNumber: serial, certifier: pub }
  const pending = client.relinquishCertificate(args)
  args.type = typeOf(39)
  args.serialNumber = toBase64(Array.from({ length: 32 }, () => 9))
  release([0, 1])
  await pending
  const reader = new ReaderUint8Array(requests[1])
  expect(Array.from(reader.read(5))).toEqual([29, 0, 1, 1, 20])
  expect(readCertificateType(reader, true)).toBe(typeOf(16))
  expect(toBase64(reader.read(32))).toBe(serial)
})

test.each(historicalVectors.vectors)('SDK 2.7.1 vector: $length type bytes', async vector => {
  const certificate = Certificate.fromObject(vector.certificate)
  expect(toHex(historicalPreimage(certificate))).toBe(vector.preimageHex)
  await expect(certificate.verify()).resolves.toBe(true)
  expect(toHex(encodeWireCertificate(certificate, true))).toBe(vector.wireCertificateHex)
  const writer = new WriterUint8Array()
  writeCertificateType(writer, certificate.type, true)
  expect(toHex(writer.toUint8Array())).toBe(vector.typeSlotHex)
  await expect(
    decodeWireCertificate(toArray(vector.wireCertificateHex, 'hex'), true).verify()
  ).resolves.toBe(true)
})

test('profile discovery restores certificates without metadata in keyrings or decrypted fields', async () => {
  const cert = makeCertificate()
  const discovered = {
    ...cert,
    certifierInfo: {
      name: 'Issuer',
      iconUrl: 'https://example.com/icon.png',
      description: 'Test issuer',
      trust: 1
    },
    publiclyRevealedKeyring: { name: 'a2V5' },
    decryptedFields: { name: 'Alice' }
  }
  const wallet = {
    discoverByIdentityKey: async () => ({ totalCertificates: 1, certificates: [discovered] }),
    discoverByAttributes: async () => ({ totalCertificates: 1, certificates: [discovered] })
  } as unknown as WalletInterface
  const client = new WalletWireTransceiver(new WalletWireProcessor(wallet))
  for (const response of [
    await client.discoverByIdentityKey({ identityKey: pub }),
    await client.discoverByAttributes({ attributes: { name: 'Alice' } })
  ]) {
    expect(response.certificates[0]).toEqual(discovered)
    expect(response.certificates[0].publiclyRevealedKeyring).not.toHaveProperty(
      CERTIFICATE_TYPE_FIELD
    )
    expect(response.certificates[0].decryptedFields).not.toHaveProperty(CERTIFICATE_TYPE_FIELD)
  }
})

test('type slots reject non-minimal length encodings and truncated payloads', () => {
  const marker = toArray(CERTIFICATE_TYPE_MARKER, 'base64')
  expect(() =>
    readCertificateType(new ReaderUint8Array([...marker, 0xfd, 1, 0, 3]), true)
  ).toThrow()
  expect(() => readCertificateType(new ReaderUint8Array([...marker, 16, 3]), true)).toThrow()
  expect(() =>
    readCertificateType(
      new ReaderUint8Array([...marker, 32, ...toArray(typeOf(32), 'base64')]),
      true
    )
  ).toThrow()
})

test('the existing field-value budget also bounds displaced-field transport metadata', () => {
  const certificate = makeCertificate(typeOf(16), {
    name: 'ZW5j',
    [CERTIFICATE_TYPE_FIELD]: 'A'.repeat(1024 * 1024)
  })
  expect(() => encodeWireCertificate(certificate, true)).toThrow(/exceeds/)
})

test('a capability transport failure never downgrades or invokes a mutation', async () => {
  const transmitToWallet = jest.fn(async () => {
    throw new Error('offline')
  })
  const client = new WalletWireTransceiver({ transmitToWallet })
  await expect(
    client.relinquishCertificate({ type: typeOf(16), serialNumber: serial, certifier: pub })
  ).rejects.toThrow('offline')
  expect(transmitToWallet).toHaveBeenCalledTimes(1)
})

test.each([1, 2])(
  'explicit old-endpoint capability rejection (%i) preserves canonical calls',
  async code => {
    const writer = new WriterUint8Array()
    const message = toArray(code === 1 ? 'Invalid call code: 29' : 'Unsupported action', 'utf8')
    writer.writeUInt8(code)
    writer.writeVarIntNum(message.length)
    writer.write(message)
    writer.writeVarIntNum(0)
    const certificate = makeCertificate(typeOf(32))
    const wallet = {
      listCertificates: async () => ({ totalCertificates: 1, certificates: [{ ...certificate }] })
    } as unknown as WalletInterface
    const processor = new WalletWireProcessor(wallet)
    const frames: number[][] = []
    const client = new WalletWireTransceiver({
      transmitToWallet: async frame => {
        frames.push(frame)
        return frame[0] === 29
          ? Array.from(writer.toUint8Array())
          : await processor.transmitToWallet(frame)
      }
    })
    expect(
      (await client.listCertificates({ types: [], certifiers: [] })).certificates[0].type
    ).toBe(certificate.type)
    await expect(
      client.relinquishCertificate({ type: typeOf(16), serialNumber: serial, certifier: pub })
    ).rejects.toThrow(/does not support legacy/)
    expect(frames.map(frame => frame[0])).toEqual([29, 18])
  }
)

test('unknown wallet errors during negotiation propagate without downgrade', async () => {
  const writer = new WriterUint8Array()
  const message = toArray('Authentication failed', 'utf8')
  writer.writeUInt8(1)
  writer.writeVarIntNum(message.length)
  writer.write(message)
  writer.writeVarIntNum(0)
  const transmitToWallet = jest.fn(async () => Array.from(writer.toUint8Array()))
  const client = new WalletWireTransceiver({ transmitToWallet })
  await expect(client.listCertificates({ types: [], certifiers: [] })).rejects.toThrow(
    'Authentication failed'
  )
  expect(transmitToWallet).toHaveBeenCalledTimes(1)
})

test('a changed public wire instance gets its own negotiation result', async () => {
  const first = jest.fn(async () => [0, 1])
  const client = new WalletWireTransceiver({ transmitToWallet: first })
  await expect(
    client.relinquishCertificate({ type: typeOf(16), serialNumber: serial, certifier: pub })
  ).rejects.toThrow()
  const second = jest.fn(async () => [0, 99])
  client.wire = { transmitToWallet: second }
  await expect(
    client.relinquishCertificate({ type: typeOf(16), serialNumber: serial, certifier: pub })
  ).rejects.toThrow(/capability/)
  expect(second).toHaveBeenCalledTimes(1)
})

test('all supported type lengths round-trip a deterministic varied byte corpus', () => {
  let seed = 0x52b100
  for (let length = 1; length <= 128; length++) {
    const type = toBase64(
      Array.from({ length }, () => {
        seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0
        return seed & 255
      })
    )
    const original = makeCertificate(type, { name: 'ZW5j', é: 'AQ==' })
    expect(decodeWireCertificate(encodeWireCertificate(original, true), true)).toEqual(original)
    const writer = new WriterUint8Array()
    writeCertificateType(writer, type, true)
    expect(readCertificateType(new ReaderUint8Array(writer.toUint8Array()), true)).toBe(type)
  }
})

test('a caller cannot retarget an in-flight negotiated mutation to another wire', async () => {
  let release!: (response: number[]) => void
  const probe = new Promise<number[]>(resolve => {
    release = resolve
  })
  const original = jest.fn(async (frame: number[]) => (frame[2] === 0 ? await probe : [0]))
  const replacement = jest.fn(async () => [0])
  const client = new WalletWireTransceiver({ transmitToWallet: original })
  const pending = client.relinquishCertificate({
    type: typeOf(16),
    serialNumber: serial,
    certifier: pub
  })
  client.wire = { transmitToWallet: replacement }
  release([0, 1])
  await expect(pending).resolves.toEqual({ relinquished: true })
  expect(original).toHaveBeenCalledTimes(2)
  expect(replacement).not.toHaveBeenCalled()
})

test('canonical verification retains the public serialization hook', async () => {
  const certificate = makeCertificate(typeOf(32))
  await signHistorical(certificate)
  const serialize = jest.spyOn(certificate, 'toBinary')
  await expect(certificate.verify()).resolves.toBe(true)
  expect(serialize).toHaveBeenCalledWith(false)
})

test.each([16, 32])('request type slots retain whitespace normalization for %i bytes', length => {
  const writer = new WriterUint8Array()
  writeCertificateType(writer, ` \t${typeOf(length)}\n`, true)
  expect(readCertificateType(new ReaderUint8Array(writer.toUint8Array()), true)).toBe(
    typeOf(length)
  )
})
