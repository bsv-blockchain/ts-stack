import { PushDrop, Utils } from '@bsv/sdk'
import { WalletPermissionsManager } from '../WalletPermissionsManager'

jest.mock('@bsv/sdk', () => {
  const { MockedBSV_SDK } = jest.requireActual('./WalletPermissionsManager.fixtures')
  return MockedBSV_SDK
})

describe('WalletPermissionsManager permission-token parsing', () => {
  const output = { outpoint: 'txid.0', satoshis: 7 }
  const result = { outputs: [output] }
  const transaction = {
    outputs: [{ lockingScript: { toHex: () => 'locking-script' } }],
    toBEEF: () => [1, 2, 3]
  }
  let manager: WalletPermissionsManager

  beforeEach(() => {
    manager = new WalletPermissionsManager({} as any, 'admin.example')
    jest.spyOn(manager as any, 'parseOutpoint').mockReturnValue(['txid', 0])
    jest.spyOn(manager as any, 'transactionFromResultBeef').mockReturnValue(transaction)
  })

  afterEach(() => {
    jest.restoreAllMocks()
  })

  test('parses a matching protocol permission token', async () => {
    jest.spyOn(PushDrop, 'decode').mockReturnValue({
      fields: Array.from({ length: 6 }, () => [1])
    } as any)
    jest.spyOn(manager as any, 'decryptProtocolTokenFields').mockResolvedValue({
      domainDecoded: 'example.com',
      expiryDecoded: 123,
      privDecoded: true,
      secLevelDecoded: 2,
      protoNameDecoded: 'protocol',
      cptyDecoded: 'counterparty'
    })

    const token = await (manager as any).parseProtocolTokenOutput(result, output, {
      originator: 'example.com',
      privileged: true,
      securityLevel: 2,
      protocolName: 'protocol',
      counterparty: 'counterparty'
    })

    expect(token).toMatchObject({
      tx: [1, 2, 3],
      txid: 'txid',
      outputIndex: 0,
      outputScript: 'locking-script',
      satoshis: 7,
      originator: 'example.com',
      privileged: true,
      protocol: 'protocol',
      securityLevel: 2,
      expiry: 123,
      counterparty: 'counterparty'
    })
  })

  test('parses a matching basket permission token', async () => {
    jest.spyOn(PushDrop, 'decode').mockReturnValue({
      fields: [Utils.toArray('example.com', 'utf8'), Utils.toArray('123', 'utf8'), Utils.toArray('basket', 'utf8')]
    } as any)
    jest.spyOn(manager as any, 'decryptPermissionTokenField').mockImplementation(async field => field)

    const token = await (manager as any).parseBasketTokenOutput(result, output, 'example.com', 'basket')

    expect(token).toMatchObject({
      tx: [1, 2, 3],
      txid: 'txid',
      outputIndex: 0,
      outputScript: 'locking-script',
      satoshis: 7,
      originator: 'example.com',
      rawOriginator: 'example.com',
      basketName: 'basket',
      expiry: 123
    })
  })

  test('parses a matching certificate permission token', async () => {
    jest.spyOn(PushDrop, 'decode').mockReturnValue({
      fields: [
        Utils.toArray('example.com', 'utf8'),
        Utils.toArray('123', 'utf8'),
        Utils.toArray('true', 'utf8'),
        Utils.toArray('certificate-type', 'utf8'),
        Utils.toArray(JSON.stringify(['name', 'email']), 'utf8'),
        Utils.toArray('verifier', 'utf8')
      ]
    } as any)
    jest.spyOn(manager as any, 'decryptPermissionTokenField').mockImplementation(async field => field)

    const token = await (manager as any).parseCertificateTokenOutput(result, output, {
      originator: 'example.com',
      privileged: true,
      verifier: 'verifier',
      certType: 'certificate-type',
      fields: ['name']
    })

    expect(token).toMatchObject({
      tx: [1, 2, 3],
      txid: 'txid',
      outputIndex: 0,
      outputScript: 'locking-script',
      satoshis: 7,
      originator: 'example.com',
      rawOriginator: 'example.com',
      privileged: true,
      verifier: 'verifier',
      certType: 'certificate-type',
      certFields: ['name', 'email'],
      expiry: 123
    })
  })

  test('encrypts non-empty internalize-action basket instructions', async () => {
    const requestArgs = {
      description: 'internalize',
      tx: [1],
      outputs: [
        {
          outputIndex: 0,
          protocol: 'basket insertion',
          insertionRemittance: {
            basket: 'basket',
            customInstructions: 'plain'
          }
        }
      ]
    }
    jest.spyOn(manager as any, 'ensureBasketAccess').mockResolvedValue(undefined)
    jest.spyOn(manager as any, 'maybeEncryptMetadata').mockResolvedValue('encrypted')

    await (manager as any).authorizeInternalizeActionBaskets(requestArgs, 'example.com', [
      { outIndex: '0', basket: 'basket', customInstructions: 'plain' }
    ])

    expect(requestArgs.outputs[0].insertionRemittance.customInstructions).toBe('encrypted')
  })
})
