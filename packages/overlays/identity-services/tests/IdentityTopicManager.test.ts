import IdentityTopicManager from '../backend/src/IdentityTopicManager'
import docs from '../backend/src/docs/IdentityTopicManagerDocs.md'
import {
  ProtoWallet,
  PushDrop,
  Transaction,
  Utils,
  VerifiableCertificate
} from '@bsv/sdk'

jest.mock('@bsv/sdk', () => {
  return {
    Transaction: {
      fromBEEF: jest.fn()
    },
    PushDrop: {
      decode: jest.fn()
    },
    Utils: {
      toUTF8: jest.fn()
    },
    ProtoWallet: jest.fn(),
    VerifiableCertificate: jest.fn()
  }
})

const mockConsoleError = jest.spyOn(console, 'error').mockImplementation(() => { })
const mockConsoleLog = jest.spyOn(console, 'log').mockImplementation(() => { })
const mockConsoleWarn = jest.spyOn(console, 'warn').mockImplementation(() => { })

const MockedProtoWallet = ProtoWallet as unknown as jest.MockedClass<typeof ProtoWallet>
const MockedVerifiableCertificate = VerifiableCertificate as unknown as jest.MockedClass<typeof VerifiableCertificate>
const mockFromBEEF = Transaction.fromBEEF as jest.Mock
const mockDecode = PushDrop.decode as jest.Mock
const mockToUTF8 = Utils.toUTF8 as jest.Mock

const buildParsedTransaction = (outputCount: number) => ({
  inputs: [{ sourceTXID: 'prev', sourceOutputIndex: 0 }],
  outputs: Array.from({ length: outputCount }, () => ({ lockingScript: [1, 2, 3] })),
  id: jest.fn().mockReturnValue('test-txid')
})

const buildValidCertificateJSON = () => JSON.stringify({
  type: 'testType',
  serialNumber: 'serial',
  subject: 'subject-pubkey',
  certifier: 'certifier-pubkey',
  revocationOutpoint: 'revocationTxid.0',
  fields: { firstName: 'Alice' },
  keyring: { firstName: 'encrypted' },
  signature: 'signature'
})

const getConsoleErrorMessages = (): string[] => {
  return mockConsoleError.mock.calls.map(call => String(call[0]))
}

describe('IdentityTopicManager', () => {
  let manager: IdentityTopicManager
  let verifySignatureMock: jest.Mock
  let certificateVerifyMock: jest.Mock
  let decryptFieldsMock: jest.Mock

  beforeEach(() => {
    jest.clearAllMocks()
    manager = new IdentityTopicManager()

    verifySignatureMock = jest.fn().mockResolvedValue({ valid: true })
    MockedProtoWallet.mockImplementation(() => ({
      verifySignature: verifySignatureMock
    } as any))

    certificateVerifyMock = jest.fn().mockResolvedValue(true)
    decryptFieldsMock = jest.fn().mockResolvedValue({ firstName: 'Alice' })
    MockedVerifiableCertificate.mockImplementation(() => ({
      verify: certificateVerifyMock,
      decryptFields: decryptFieldsMock
    } as any))

    mockToUTF8.mockReturnValue(buildValidCertificateJSON())
  })

  afterAll(() => {
    mockConsoleError.mockRestore()
    mockConsoleLog.mockRestore()
    mockConsoleWarn.mockRestore()
  })

  describe('getDocumentation', () => {
    it('should return the docs markdown string', async () => {
      const result = await manager.getDocumentation()
      expect(result).toBe(docs)
    })
  })

  describe('getMetaData', () => {
    it('should return the correct metadata object', async () => {
      const result = await manager.getMetaData()
      expect(result).toEqual({
        name: 'Identity Topic Manager',
        shortDescription: 'Identity Resolution Protocol'
      })
    })
  })

  describe('identifyAdmissibleOutputs', () => {
    it('should return no admitted outputs and log error/warn when parsed transaction has no inputs', async () => {
      mockFromBEEF.mockReturnValue({
        inputs: [],
        outputs: [{ lockingScript: [1, 2, 3] }],
        id: jest.fn().mockReturnValue('test-txid')
      })

      const result = await manager.identifyAdmissibleOutputs([1, 2, 3], [])

      expect(result).toEqual({ outputsToAdmit: [], coinsToRetain: [] })
      expect(mockDecode).not.toHaveBeenCalled()
      expect(getConsoleErrorMessages()).toContain('Error identifying admissible outputs:')
      expect(mockConsoleWarn).toHaveBeenCalledWith('No Identity outputs admitted, and no previous Identity coins were consumed.')
    })

    it('should return no admitted outputs and log error/warn when parsed transaction has no outputs', async () => {
      mockFromBEEF.mockReturnValue({
        inputs: [{ sourceTXID: 'prev', sourceOutputIndex: 0 }],
        outputs: [],
        id: jest.fn().mockReturnValue('test-txid')
      })

      const result = await manager.identifyAdmissibleOutputs([1, 2, 3], [])

      expect(result).toEqual({ outputsToAdmit: [], coinsToRetain: [] })
      expect(mockDecode).not.toHaveBeenCalled()
      expect(getConsoleErrorMessages()).toContain('Error identifying admissible outputs:')
      expect(mockConsoleWarn).toHaveBeenCalledWith('No Identity outputs admitted, and no previous Identity coins were consumed.')
    })

    it('should return no admitted outputs and emit global error/warn when no outputs are valid and no previous coins are provided', async () => {
      mockFromBEEF.mockReturnValue(buildParsedTransaction(1))
      mockDecode.mockReturnValue({
        fields: [[11], [22], [33], [44]]
      })
      verifySignatureMock.mockResolvedValue({ valid: false })

      const result = await manager.identifyAdmissibleOutputs([1, 2, 3], [])

      expect(result).toEqual({ outputsToAdmit: [], coinsToRetain: [] })
      expect(getConsoleErrorMessages()).toContain('Error parsing output 0')
      expect(getConsoleErrorMessages()).toContain('Error identifying admissible outputs:')
      expect(mockConsoleWarn).toHaveBeenCalledWith('No Identity outputs admitted, and no previous Identity coins were consumed.')
    })

    it('should return no admitted outputs but avoid global error/warn when previous coins are provided', async () => {
      mockFromBEEF.mockReturnValue(buildParsedTransaction(1))
      mockDecode.mockReturnValue({
        fields: [[11], [22], [33], [44]]
      })
      verifySignatureMock.mockResolvedValue({ valid: false })

      const result = await manager.identifyAdmissibleOutputs([1, 2, 3], [42])

      expect(result).toEqual({ outputsToAdmit: [], coinsToRetain: [] })
      expect(getConsoleErrorMessages()).toContain('Error parsing output 0')
      expect(getConsoleErrorMessages()).not.toContain('Error identifying admissible outputs:')
      expect(mockConsoleWarn).not.toHaveBeenCalled()
      expect(mockConsoleLog).toHaveBeenCalledWith('Consumed 1 previous Identity coin!')
    })

    it('should parse and admit multiple valid outputs while ignoring invalid outputs', async () => {
      mockFromBEEF.mockReturnValue(buildParsedTransaction(3))
      mockDecode
        .mockImplementationOnce(() => ({ fields: [[1], [2], [3], [4]] }))
        .mockImplementationOnce(() => {
          throw new Error('Malformed output script')
        })
        .mockImplementationOnce(() => ({ fields: [[10], [20], [30], [40]] }))

      const result = await manager.identifyAdmissibleOutputs([1, 2, 3], [])

      expect(result).toEqual({ outputsToAdmit: [0, 2], coinsToRetain: [] })
      expect(getConsoleErrorMessages()).toContain('Error parsing output 1')
    })

    it('should admit a valid single output and verify signature using expected payload', async () => {
      mockFromBEEF.mockReturnValue(buildParsedTransaction(1))
      mockDecode.mockReturnValue({
        fields: [[10, 11], [20, 21], [30, 31], [99, 100]]
      })

      const result = await manager.identifyAdmissibleOutputs([1, 2, 3], [])

      expect(result).toEqual({ outputsToAdmit: [0], coinsToRetain: [] })
      expect(verifySignatureMock).toHaveBeenCalledWith({
        data: [10, 11, 20, 21, 30, 31],
        signature: [99, 100],
        counterparty: 'subject-pubkey',
        protocolID: [1, 'identity'],
        keyID: '1'
      })
      expect(certificateVerifyMock).toHaveBeenCalledTimes(1)
      expect(decryptFieldsMock).toHaveBeenCalledTimes(1)
    })

    it('should continue after per-output failures and return partial success without rethrowing', async () => {
      mockFromBEEF.mockReturnValue(buildParsedTransaction(2))
      mockDecode
        .mockImplementationOnce(() => {
          throw new Error('Decode failed')
        })
        .mockImplementationOnce(() => ({ fields: [[7], [8], [9], [10]] }))

      const result = await manager.identifyAdmissibleOutputs([1, 2, 3], [])

      expect(result).toEqual({ outputsToAdmit: [1], coinsToRetain: [] })
      expect(getConsoleErrorMessages()).toContain('Error parsing output 0')
    })
  })
})
