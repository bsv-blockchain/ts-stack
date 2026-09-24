import { WalletInterface } from '../../Wallet.interfaces.js'
import WalletWire from '../WalletWire.js'
import calls from '../WalletWireCalls.js'
import WalletWireProcessor from '../WalletWireProcessor.js'
import WalletWireTransceiver from '../WalletWireTransceiver.js'
import * as Utils from '../../../primitives/utils.js'
import { MAXIMUM_SEND_WITH_TRANSACTIONS } from '../../validationHelpers.js'
import { MAX_WALLET_WIRE_FRAME_BYTES } from '../WalletWire.js'

const GENERATOR_PUBLIC_KEY = '0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798'
const VALID_SIGNATURE_HEX = '3006020101020101'

// Frozen field layout, independent of the processor under test: success, one
// action, zero txid, amount, completed/outgoing, "Entry", labels/version/locktime,
// inputs/outputs. Negative amounts use the historical signed-int64 representation.
function historyResponse(amount: number[]): number[] {
  return [0, 1, ...Array(32).fill(0), ...amount, 1, 1, 5, 69, 110, 116, 114, 121, 0, 1, 0, 0, 0]
}

describe('WalletWire strict binary framing', () => {
  it.each([
    [
      'createAction',
      (client: WalletWireTransceiver, sendWith: string[]) =>
        client.createAction({
          description: 'bounded wire broadcast set',
          options: { sendWith }
        })
    ],
    [
      'signAction',
      (client: WalletWireTransceiver, sendWith: string[]) =>
        client.signAction({
          spends: {},
          reference: Utils.toBase64([1]),
          options: { sendWith }
        })
    ]
  ])('rejects an oversized %s sendWith list before invoking the wallet', async (method, invoke) => {
    const called = jest.fn()
    const processor = new WalletWireProcessor({ [method]: called } as unknown as WalletInterface)
    const client = new WalletWireTransceiver(processor)
    const sendWith = Array.from({ length: MAXIMUM_SEND_WITH_TRANSACTIONS + 1 }, (_, index) =>
      index.toString(16).padStart(64, '0')
    )

    await expect(invoke(client, sendWith)).rejects.toThrow('sendWith')
    expect(called).not.toHaveBeenCalled()
  })

  it.each([
    ['truncated', [0xff, 1]],
    ['non-canonical', [0xfd, 1, 0]],
    ['imprecise unsigned', [0xff, 0, 0, 0, 0, 0, 0, 0x20, 0]]
  ])('rejects a %s request before invoking the wallet', async (_name, encodedHeight) => {
    const getHeaderForHeight = jest.fn()
    const processor = new WalletWireProcessor({
      getHeaderForHeight
    } as unknown as WalletInterface)

    const response = await processor.transmitToWalletUint8Array(
      Uint8Array.from([calls.getHeaderForHeight, 0, ...encodedHeight])
    )

    expect(response[0]).not.toBe(0)
    expect(getHeaderForHeight).not.toHaveBeenCalled()
  })

  it('rejects trailing request bytes before invoking a parameterless wallet method', async () => {
    const getHeight = jest.fn()
    const processor = new WalletWireProcessor({ getHeight } as unknown as WalletInterface)

    const response = await processor.transmitToWalletUint8Array(
      Uint8Array.from([calls.getHeight, 0, 0])
    )

    expect(response[0]).not.toBe(0)
    expect(getHeight).not.toHaveBeenCalled()
  })

  it.each([
    ['identityKey', [calls.getPublicKey, 0, 2]],
    ['security level', [calls.getPublicKey, 0, 0, 3]],
    ['seekPermission', [calls.getPublicKey, 0, 1, 0xff, 0xff, 2]]
  ])('rejects an invalid %s flag before invoking the wallet', async (_name, request) => {
    const getPublicKey = jest.fn()
    const processor = new WalletWireProcessor({ getPublicKey } as unknown as WalletInterface)

    const response = await processor.transmitToWalletUint8Array(Uint8Array.from(request))

    expect(response[0]).not.toBe(0)
    expect(getPublicKey).not.toHaveBeenCalled()
  })

  it('validates security-sensitive wallet results before serializing them', async () => {
    const processor = new WalletWireProcessor({
      getNetwork: async () => ({ network: 'regtest' })
    } as unknown as WalletInterface)

    const response = await processor.transmitToWalletUint8Array(
      Uint8Array.from([calls.getNetwork, 0])
    )

    expect(response[0]).not.toBe(0)
  })

  it('rejects malformed cryptographic output from the wallet implementation', async () => {
    const processor = new WalletWireProcessor({
      createHmac: async () => ({ hmac: [1] })
    } as unknown as WalletInterface)
    const transceiver = new WalletWireTransceiver(processor)

    await expect(
      transceiver.createHmac({ data: [], protocolID: [0, 'tests'], keyID: '1' })
    ).rejects.toThrow('Invalid createHmac hmac length')
  })

  it('rejects a malformed public key returned by the wallet implementation', async () => {
    const processor = new WalletWireProcessor({
      getPublicKey: async () => ({ publicKey: `04${'00'.repeat(32)}` })
    } as unknown as WalletInterface)

    const response = await processor.transmitToWalletUint8Array(
      Uint8Array.from([calls.getPublicKey, 0, 1, 0xff, 0xff, 0xff])
    )

    expect(response[0]).not.toBe(0)
  })

  it('never turns a thrown error with code zero into a success frame or exposes its internals', async () => {
    const getHeight = jest.fn().mockRejectedValue({
      code: 0,
      message: 'height failed',
      stack: '/private/wallet/source.ts:42'
    })
    const processor = new WalletWireProcessor({ getHeight } as unknown as WalletInterface)

    const response = await processor.transmitToWalletUint8Array(
      Uint8Array.from([calls.getHeight, 0])
    )
    const reader = new Utils.ReaderUint8Array(response)

    expect(reader.readUInt8()).toBe(1)
    expect(Utils.toUTF8Strict(reader.read(reader.readVarIntNumStrict(false)))).toBe(
      'Wallet operation failed'
    )
    expect(reader.readVarIntNumStrict(false)).toBe(0)
    expect(reader.eof()).toBe(true)
  })

  it('preserves an explicit public wallet error across the wire', async () => {
    const getHeight = jest.fn().mockRejectedValue(
      Object.assign(new Error('The limit parameter must be valid.'), {
        code: 6,
        isError: true,
        name: 'WERR_INVALID_PARAMETER'
      })
    )
    const processor = new WalletWireProcessor({ getHeight } as unknown as WalletInterface)
    const response = await processor.transmitToWalletUint8Array(
      Uint8Array.from([calls.getHeight, 0])
    )
    const reader = new Utils.ReaderUint8Array(response)

    expect(reader.readUInt8()).toBe(6)
    expect(Utils.toUTF8Strict(reader.read(reader.readVarIntNumStrict(false)))).toBe(
      'The limit parameter must be valid.'
    )
    expect(reader.readVarIntNumStrict(false)).toBe(0)
    expect(reader.eof()).toBe(true)
  })

  it('rejects malformed UTF-8 in the originator before invoking the wallet', async () => {
    const getHeight = jest.fn()
    const processor = new WalletWireProcessor({ getHeight } as unknown as WalletInterface)

    const response = await processor.transmitToWalletUint8Array(
      Uint8Array.from([calls.getHeight, 1, 0xff])
    )

    expect(response[0]).not.toBe(0)
    expect(getHeight).not.toHaveBeenCalled()
  })

  it('preserves paginated records when the total exceeds the returned page length', async () => {
    const listOutputs = jest.fn().mockResolvedValue({
      totalOutputs: 2,
      outputs: [{ outpoint: `${'00'.repeat(32)}.0`, satoshis: 1, spendable: true }]
    })
    const transceiver = new WalletWireTransceiver(
      new WalletWireProcessor({ listOutputs } as unknown as WalletInterface)
    )

    const result = await transceiver.listOutputs({ basket: 'default', limit: 1 })

    expect(result.totalOutputs).toBe(2)
    expect(result.outputs).toHaveLength(1)
    expect(result.outputs[0].satoshis).toBe(1)
  })

  it.each([-21e14, -65536, -222, -1, 0, 253, 65536, 21e14])(
    'preserves signed action-history amount %s on legacy wire',
    async satoshis => {
      const transceiver = new WalletWireTransceiver(
        new WalletWireProcessor({
          listActions: async () => ({
            totalActions: 1,
            actions: [
              {
                txid: '00'.repeat(32),
                satoshis,
                status: 'completed',
                isOutgoing: true,
                description: 'Outgoing history action',
                version: 1,
                lockTime: 0
              }
            ]
          })
        } as unknown as WalletInterface)
      )

      await expect(transceiver.listActions({ labels: [] })).resolves.toMatchObject({
        actions: [{ satoshis }]
      })
    }
  )

  it('decodes the published signed history representation without a new wire format', async () => {
    const wire: WalletWire = {
      transmitToWallet: async () => historyResponse([255, 34, 255, 255, 255, 255, 255, 255, 255])
    }
    await expect(
      new WalletWireTransceiver(wire).listActions({ labels: [] })
    ).resolves.toMatchObject({
      actions: [{ satoshis: -222, isOutgoing: true, status: 'completed' }]
    })
  })

  it.each([
    ['negative outside supply', Utils.Writer.varIntNum(-21e14 - 1)],
    ['positive outside supply', Utils.Writer.varIntNum(21e14 + 1)],
    ['unsafe signed integer', [255, 0, 0, 0, 0, 0, 0, 0, 128]],
    ['noncanonical uint16', [253, 1, 0]],
    ['noncanonical uint32', [254, 253, 0, 0, 0]],
    ['noncanonical uint64', [255, 1, 0, 0, 0, 0, 0, 0, 0]]
  ])('rejects %s action-history amounts', async (_name, amount) => {
    const wire: WalletWire = { transmitToWallet: async () => historyResponse(amount as number[]) }
    await expect(new WalletWireTransceiver(wire).listActions({ labels: [] })).rejects.toThrow()
  })

  it('rejects truncated signed history amounts', async () => {
    const wire: WalletWire = {
      transmitToWallet: async () => [0, 1, ...Array(32).fill(0), 255, 255]
    }
    await expect(new WalletWireTransceiver(wire).listActions({ labels: [] })).rejects.toThrow(
      'available data'
    )
  })

  it('still rejects negative individual output values in action history', async () => {
    const prefix = historyResponse([0]).slice(0, -1)
    const wire: WalletWire = {
      transmitToWallet: async () => [...prefix, 1, 0, ...Utils.Writer.varIntNum(-1)]
    }
    await expect(new WalletWireTransceiver(wire).listActions({ labels: [] })).rejects.toThrow(
      'number too large'
    )
  })

  it('rejects a direct binary request that bypasses transceiver argument validation', async () => {
    const listActions = jest.fn()
    const processor = new WalletWireProcessor({ listActions } as unknown as WalletInterface)
    const params = new Utils.WriterUint8Array()
    params.writeVarIntNum(0) // labels
    params.writeInt8(-1) // labelQueryMode
    for (let i = 0; i < 6; i++) params.writeInt8(-1) // include options
    params.writeVarIntNum(10_001) // limit exceeds the BRC-100 maximum
    params.writeVarIntNum(-1) // offset
    params.writeInt8(-1) // seekPermission

    const response = await processor.transmitToWalletUint8Array(
      Uint8Array.from([calls.listActions, 0, ...params.toUint8Array()])
    )

    expect(response[0]).not.toBe(0)
    expect(listActions).not.toHaveBeenCalled()
  })

  it('rejects an excessive collection count before iterating the frame', async () => {
    const discoverByAttributes = jest.fn()
    const processor = new WalletWireProcessor({
      discoverByAttributes
    } as unknown as WalletInterface)
    const params = new Utils.WriterUint8Array()
    params.writeVarIntNum(33)

    const response = await processor.transmitToWalletUint8Array(
      Uint8Array.from([calls.discoverByAttributes, 0, ...params.toUint8Array()])
    )

    expect(response[0]).not.toBe(0)
    expect(discoverByAttributes).not.toHaveBeenCalled()
  })

  it('rejects oversized and sparse legacy request frames before conversion', async () => {
    const processor = new WalletWireProcessor({} as WalletInterface)
    const oversized: number[] = []
    oversized.length = MAX_WALLET_WIRE_FRAME_BYTES + 1
    await expect(processor.transmitToWallet(oversized)).rejects.toThrow('maximum permitted size')

    const sparse: number[] = []
    sparse.length = 3
    sparse[0] = calls.getHeight
    sparse[2] = 0
    await expect(processor.transmitToWallet(sparse)).rejects.toThrow('dense byte array')
  })

  it('rejects malformed custom-wire responses before parsing', async () => {
    const oversizedResponse: number[] = []
    oversizedResponse.length = MAX_WALLET_WIRE_FRAME_BYTES + 1
    const legacy = new WalletWireTransceiver({
      transmitToWallet: async () => oversizedResponse
    })
    await expect(legacy.getHeight({})).rejects.toThrow('maximum permitted size')

    const compact = new WalletWireTransceiver({
      transmitToWallet: async () => [0],
      transmitToWalletUint8Array: async () => [0] as unknown as Uint8Array
    })
    await expect(compact.getHeight({})).rejects.toThrow('maximum permitted size')
  })

  it('rejects a malformed signing result from a direct wire substrate', async () => {
    const client = new WalletWireTransceiver({
      transmitToWallet: async () => [0, 1, 2, 3]
    })

    await expect(
      client.createSignature({
        data: [1],
        protocolID: [0, 'test protocol'],
        keyID: 'test-key'
      })
    ).rejects.toThrow('canonical DER-encoded ECDSA signature')
  })

  it('does not serialize a malformed signature returned by a wallet implementation', async () => {
    const client = new WalletWireTransceiver(
      new WalletWireProcessor({
        createSignature: async () => ({ signature: [1, 2, 3] })
      } as unknown as WalletInterface)
    )

    await expect(
      client.createSignature({
        data: [1],
        protocolID: [0, 'test protocol'],
        keyID: 'test-key'
      })
    ).rejects.toThrow('canonical DER-encoded ECDSA signature')
  })

  it('stops decoding a wallet response once it exceeds the requested page limit', async () => {
    const outputs = [0, 1].map(index => ({
      outpoint: `${index.toString(16).padStart(64, '0')}.0`,
      satoshis: 1,
      spendable: true
    }))
    const client = new WalletWireTransceiver(
      new WalletWireProcessor({
        listOutputs: async () => ({ totalOutputs: outputs.length, outputs })
      } as unknown as WalletInterface)
    )

    await expect(client.listOutputs({ basket: 'default', limit: 1 })).rejects.toThrow(
      /requested limit|requested page limit/
    )
  })

  it('rejects oversized nested response collections before iterating them', async () => {
    const resultWriter = new Utils.WriterUint8Array()
    resultWriter.writeUInt8(0) // success
    resultWriter.writeVarIntNum(1) // totalOutputs
    resultWriter.writeVarIntNum(-1) // BEEF
    resultWriter.write(new Uint8Array(32)) // txid
    resultWriter.writeVarIntNum(0) // output index
    resultWriter.writeVarIntNum(1) // satoshis
    resultWriter.writeVarIntNum(-1) // lockingScript
    resultWriter.writeVarIntNum(-1) // customInstructions
    resultWriter.writeVarIntNum(100_001) // tags
    resultWriter.write(new Uint8Array(100_001)) // empty tag lengths
    resultWriter.writeVarIntNum(-1) // labels
    const client = new WalletWireTransceiver({
      transmitToWallet: async () => Array.from(resultWriter.toUint8Array())
    })

    await expect(
      client.listOutputs({ basket: 'default', includeTags: true, limit: 1 })
    ).rejects.toThrow('maximum collection size of 100000')
  })

  it('frames Unicode discovery attributes by UTF-8 byte length', async () => {
    const discoverByAttributes = jest.fn(async () => ({
      totalCertificates: 0,
      certificates: []
    }))
    const client = new WalletWireTransceiver(
      new WalletWireProcessor({ discoverByAttributes } as unknown as WalletInterface)
    )

    await expect(
      client.discoverByAttributes({ attributes: { naïve: 'café' }, limit: 1 })
    ).resolves.toEqual({ totalCertificates: 0, certificates: [] })
    expect(discoverByAttributes).toHaveBeenCalledWith(
      expect.objectContaining({ attributes: { naïve: 'café' }, limit: 1 }),
      ''
    )
  })

  it.each([
    ['truncated', [0, 0xff, 1]],
    ['non-canonical', [0, 0xfd, 1, 0]],
    ['negative sentinel', [0, 0xff, ...Array(8).fill(0xff)]]
  ])('rejects a %s unsigned response field', async (_name, response) => {
    const wire: WalletWire = {
      transmitToWallet: async () => response
    }
    const transceiver = new WalletWireTransceiver(wire)

    await expect(transceiver.getHeight({})).rejects.toThrow()
  })

  it.each([
    ['getHeight trailing data', [0, 1, 0], (client: WalletWireTransceiver) => client.getHeight({})],
    [
      'invalid authentication verdict',
      [0, 2],
      (client: WalletWireTransceiver) => client.isAuthenticated({})
    ],
    ['invalid network byte', [0, 2], (client: WalletWireTransceiver) => client.getNetwork({})],
    [
      'trailing empty-result data',
      [0, 0],
      (client: WalletWireTransceiver) =>
        client.verifyHmac({
          data: [],
          hmac: Array(32).fill(0),
          protocolID: [0, 'test'],
          keyID: '1'
        })
    ],
    [
      'short HMAC',
      [0, 1],
      (client: WalletWireTransceiver) =>
        client.createHmac({ data: [], protocolID: [0, 'test'], keyID: '1' })
    ]
  ])('rejects %s from a hostile wire', async (_name, response, invoke) => {
    const wire: WalletWire = { transmitToWallet: async () => response }
    await expect(invoke(new WalletWireTransceiver(wire))).rejects.toThrow()
  })

  it('rejects trailing bytes on an error frame', async () => {
    const wire: WalletWire = { transmitToWallet: async () => [1, 0, 0, 0] }
    const transceiver = new WalletWireTransceiver(wire)
    await expect(transceiver.getHeight({})).rejects.toThrow('trailing data')
  })

  it('rejects invalid response presence flags instead of silently treating them as absent', async () => {
    const wire: WalletWire = { transmitToWallet: async () => [0, 2] }
    const transceiver = new WalletWireTransceiver(wire)
    await expect(transceiver.createAction({ description: 'test action' })).rejects.toThrow(
      'txid present'
    )
  })

  it('rejects prototype-sensitive record keys from a hostile wire response', async () => {
    const key = Utils.toArray('__proto__', 'utf8')
    const wire: WalletWire = {
      transmitToWallet: async () => [0, 1, key.length, ...key, 0]
    }
    const transceiver = new WalletWireTransceiver(wire)

    await expect(
      transceiver.proveCertificate({
        certificate: {
          type: Utils.toBase64(Array(32).fill(0)),
          serialNumber: Utils.toBase64(Array(32).fill(0)),
          subject: GENERATOR_PUBLIC_KEY,
          certifier: GENERATOR_PUBLIC_KEY,
          revocationOutpoint: `${'00'.repeat(32)}.0`,
          fields: {},
          signature: VALID_SIGNATURE_HEX
        },
        fieldsToReveal: [],
        verifier: GENERATOR_PUBLIC_KEY
      })
    ).rejects.toThrow('Unsafe proveCertificate keyring key')
  })

  it('rejects duplicate proof keyring fields from a hostile wire response', async () => {
    const key = Utils.toArray('name', 'utf8')
    const wire: WalletWire = {
      transmitToWallet: async () => [0, 2, key.length, ...key, 1, 1, key.length, ...key, 1, 2]
    }
    const transceiver = new WalletWireTransceiver(wire)

    await expect(
      transceiver.proveCertificate({
        certificate: {
          type: Utils.toBase64(Array(32).fill(0)),
          serialNumber: Utils.toBase64(Array(32).fill(0)),
          subject: GENERATOR_PUBLIC_KEY,
          certifier: GENERATOR_PUBLIC_KEY,
          revocationOutpoint: `${'00'.repeat(32)}.0`,
          fields: { name: 'encrypted' },
          signature: VALID_SIGNATURE_HEX
        },
        fieldsToReveal: ['name'],
        verifier: GENERATOR_PUBLIC_KEY
      })
    ).rejects.toThrow('Duplicate proveCertificate keyring key: name')
  })

  it('rejects duplicate discovery attribute keys before invoking the wallet', async () => {
    const writer = new Utils.WriterUint8Array()
    const key = Utils.toUint8Array('name', 'utf8')
    const firstValue = Utils.toUint8Array('Alice', 'utf8')
    const secondValue = Utils.toUint8Array('Mallory', 'utf8')
    writer.writeUInt8(calls.discoverByAttributes)
    writer.writeUInt8(0)
    writer.writeVarIntNum(2)
    for (const value of [firstValue, secondValue]) {
      writer.writeVarIntNum(key.length)
      writer.write(key)
      writer.writeVarIntNum(value.length)
      writer.write(value)
    }
    writer.writeVarIntNum(-1)
    writer.writeVarIntNum(-1)
    writer.writeInt8(-1)

    const called = jest.fn()
    const processor = new WalletWireProcessor({
      discoverByAttributes: called
    } as unknown as WalletInterface)
    const response = await processor.transmitToWalletUint8Array(writer.toUint8Array())

    expect(response[0]).not.toBe(0)
    expect(called).not.toHaveBeenCalled()
  })
})
