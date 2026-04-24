import { describe, it, expect, beforeEach, jest } from '@jest/globals'
import MessageBoxTopicManager from '../topic-managers/MessageBoxTopicManager.js'
import { PushDrop, ProtoWallet, Transaction, Utils } from '@bsv/sdk'

var verifySignatureMock: jest.Mock

jest.mock('@bsv/sdk', () => ({
  PushDrop: {
    decode: jest.fn()
  },
  ProtoWallet: jest.fn().mockImplementation(() => {
    verifySignatureMock = jest.fn()
    return {
      verifySignature: verifySignatureMock
    }
  }),
  Utils: {
    toUTF8: jest.fn(),
    toHex: jest.fn()
  },
  Transaction: {
    fromBEEF: jest.fn()
  }
}))

describe('MessageBoxTopicManager', () => {
  const manager = new MessageBoxTopicManager()

  const mockedDecode = PushDrop.decode as jest.Mock
  const mockedFromBEEF = Transaction.fromBEEF as jest.Mock
  const mockedToUTF8 = Utils.toUTF8 as jest.Mock
  const mockedToHex = Utils.toHex as jest.Mock

  beforeEach(() => {
    jest.clearAllMocks()
    mockedToHex.mockReturnValue('identity-key')
    mockedToUTF8.mockReturnValue('https://host.example.com')
    verifySignatureMock.mockImplementation(async () => ({ valid: true }))
  })

  it('admits valid outputs and removes previous coins', async () => {
    mockedFromBEEF.mockReturnValue({
      outputs: [{ lockingScript: 'ls0' }]
    })

    mockedDecode.mockReturnValue({
      fields: [[1, 2, 3], [4, 5, 6], [7, 8]]
    })

    const result = await manager.identifyAdmissibleOutputs([1], [11, 12])

    expect(result).toEqual({
      outputsToAdmit: [0],
      coinsToRetain: [],
      coinsRemoved: [11, 12]
    })
    expect(verifySignatureMock).toHaveBeenCalledWith({
      data: [1, 2, 3, 4, 5, 6],
      signature: [7, 8],
      counterparty: 'identity-key',
      protocolID: [1, 'messagebox advertisement'],
      keyID: '1'
    })
  })

  it('skips outputs with missing identity or host fields', async () => {
    mockedFromBEEF.mockReturnValue({
      outputs: [{ lockingScript: 'ls0' }]
    })

    mockedDecode.mockReturnValue({
      fields: [[], [4, 5], [7]]
    })

    const result = await manager.identifyAdmissibleOutputs([1], [5])

    expect(result.outputsToAdmit).toEqual([])
    expect(verifySignatureMock).not.toHaveBeenCalled()
    expect(result.coinsRemoved).toEqual([5])
  })

  it('skips outputs when host utf8 decoding fails', async () => {
    mockedFromBEEF.mockReturnValue({
      outputs: [{ lockingScript: 'ls0' }]
    })

    mockedDecode.mockReturnValue({
      fields: [[1, 2], [9, 9], [7, 8]]
    })
    mockedToUTF8.mockImplementation(() => {
      throw new Error('bad utf8')
    })

    const result = await manager.identifyAdmissibleOutputs([1], [5])

    expect(result.outputsToAdmit).toEqual([])
    expect(verifySignatureMock).not.toHaveBeenCalled()
  })

  it('continues processing when an output fails to decode', async () => {
    mockedFromBEEF.mockReturnValue({
      outputs: [{ lockingScript: 'ls0' }, { lockingScript: 'ls1' }]
    })

    mockedDecode
      .mockImplementationOnce(() => {
        throw new Error('decode failure')
      })
      .mockImplementationOnce(() => ({
        fields: [[1], [2], [3]]
      }))

    const result = await manager.identifyAdmissibleOutputs([1], [])

    expect(result.outputsToAdmit).toEqual([1])
  })

  it('returns empty instructions if transaction parsing throws', async () => {
    mockedFromBEEF.mockImplementation(() => {
      throw new Error('bad beef')
    })

    const result = await manager.identifyAdmissibleOutputs([1], [9])

    expect(result).toEqual({
      outputsToAdmit: [],
      coinsToRetain: [],
      coinsRemoved: []
    })
  })

  it('skips output when signature verification fails', async () => {
    mockedFromBEEF.mockReturnValue({
      outputs: [{ lockingScript: 'ls0' }]
    })
    mockedDecode.mockReturnValue({
      fields: [[1, 2], [3, 4], [5, 6]]
    })
    verifySignatureMock.mockImplementation(async () => ({ valid: false }))

    const result = await manager.identifyAdmissibleOutputs([1], [])

    expect(result.outputsToAdmit).toEqual([])
    expect(verifySignatureMock).toHaveBeenCalled()
  })

  it('admits only valid outputs when tx has mixed validity', async () => {
    mockedFromBEEF.mockReturnValue({
      outputs: [
        { lockingScript: 'ls0' },
        { lockingScript: 'ls1' },
        { lockingScript: 'ls2' }
      ]
    })

    // output 0: valid decode + valid sig
    // output 1: valid decode + invalid sig
    // output 2: decode throws
    mockedDecode
      .mockReturnValueOnce({ fields: [[1], [2], [10]] })
      .mockReturnValueOnce({ fields: [[3], [4], [11]] })
      .mockImplementationOnce(() => { throw new Error('corrupt') })

    verifySignatureMock
      .mockImplementationOnce(async () => ({ valid: true }))
      .mockImplementationOnce(async () => ({ valid: false }))

    const result = await manager.identifyAdmissibleOutputs([1], [7, 8])

    expect(result.outputsToAdmit).toEqual([0])
    expect(result.coinsRemoved).toEqual([7, 8])
  })

  it('returns empty coinsRemoved when previousCoins is empty', async () => {
    mockedFromBEEF.mockReturnValue({
      outputs: [{ lockingScript: 'ls0' }]
    })
    mockedDecode.mockReturnValue({ fields: [[1], [2], [3]] })

    const result = await manager.identifyAdmissibleOutputs([1], [])

    expect(result.coinsRemoved).toEqual([])
  })

  it('getDocumentation returns a string', async () => {
    const docs = await manager.getDocumentation()
    expect(typeof docs).toBe('string')
  })

  it('getMetaData returns name and shortDescription', async () => {
    const meta = await manager.getMetaData()
    expect(meta).toEqual({
      name: 'MessageBox Topic Manager',
      shortDescription: 'Advertises and validates hosts for message routing.'
    })
  })

  it('getTopics returns tm_messagebox', () => {
    expect(manager.getTopics()).toEqual(['tm_messagebox'])
  })
})
