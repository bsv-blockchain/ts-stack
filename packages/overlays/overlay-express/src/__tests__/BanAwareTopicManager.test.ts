import { describe, it, expect, jest, beforeEach } from '@jest/globals'
import { TopicManager } from '@bsv/overlay'
import { PushDrop, Transaction, Utils } from '@bsv/sdk'
import { BanAwareTopicManager } from '../BanAwareTopicManager.js'
import { BanService } from '../BanService.js'

jest.mock('@bsv/sdk', () => ({
  PushDrop: {
    decode: jest.fn()
  },
  Transaction: {
    fromBEEF: jest.fn()
  },
  Utils: {
    toUTF8: jest.fn()
  }
}))

const mockPushDropDecode = PushDrop.decode as unknown as jest.Mock<any>
const mockTransactionFromBEEF = Transaction.fromBEEF as unknown as jest.Mock<any>
const mockToUTF8 = Utils.toUTF8 as unknown as jest.Mock<any>

describe('BanAwareTopicManager', () => {
  let wrapper: BanAwareTopicManager
  let mockWrapped: jest.Mocked<TopicManager>
  let mockBanService: jest.Mocked<BanService>
  let mockLogger: any

  beforeEach(() => {
    jest.clearAllMocks()

    mockWrapped = {
      identifyAdmissibleOutputs: jest.fn<any>().mockResolvedValue({
        outputsToAdmit: [0, 1],
        coinsToRetain: [0],
        coinsRemoved: [1]
      }),
      identifyNeededInputs: jest.fn<any>().mockResolvedValue([{ txid: 'needed-txid', outputIndex: 0 }]),
      getDocumentation: jest.fn<any>().mockResolvedValue('docs'),
      getMetaData: jest.fn<any>().mockResolvedValue({ name: 'test', shortDescription: 'test' })
    } as any

    mockBanService = {
      isOutpointBanned: jest.fn<any>().mockResolvedValue(false),
      isDomainBanned: jest.fn<any>().mockResolvedValue(false)
    } as any

    mockLogger = {
      log: jest.fn()
    }

    mockTransactionFromBEEF.mockReturnValue({
      id: jest.fn().mockReturnValue('ad-txid'),
      outputs: [
        { lockingScript: 'script-0' },
        { lockingScript: 'script-1' }
      ]
    })
    mockPushDropDecode.mockReturnValue({
      fields: [Buffer.from('SHIP'), Buffer.from('topic'), Buffer.from('https://good.example')]
    })
    mockToUTF8.mockImplementation((value: Buffer) => value.toString('utf8'))

    wrapper = new BanAwareTopicManager(mockWrapped, mockBanService, 'SHIP', mockLogger)
  })

  it('should remove banned outpoints from admittance instructions', async () => {
    mockBanService.isOutpointBanned.mockResolvedValueOnce(true).mockResolvedValue(false)

    const result = await wrapper.identifyAdmissibleOutputs([1, 2, 3], [0], [42], 'current-tx')

    expect(result.outputsToAdmit).toEqual([1])
    expect(mockWrapped.identifyAdmissibleOutputs).toHaveBeenCalledWith([1, 2, 3], [0], [42], 'current-tx')
    expect(mockBanService.isOutpointBanned).toHaveBeenCalledWith('ad-txid', 0)
    expect(mockLogger.log).toHaveBeenCalledWith(expect.stringContaining('banned outpoint'))
  })

  it('should remove outputs whose advertised domain is banned', async () => {
    mockBanService.isDomainBanned.mockResolvedValueOnce(true).mockResolvedValue(false)

    const result = await wrapper.identifyAdmissibleOutputs([1], [])

    expect(result.outputsToAdmit).toEqual([1])
    expect(mockBanService.isDomainBanned).toHaveBeenCalledWith('https://good.example')
    expect(mockLogger.log).toHaveBeenCalledWith(expect.stringContaining('banned domain'))
  })

  it('should preserve all outputs when nothing is banned', async () => {
    const result = await wrapper.identifyAdmissibleOutputs([1], [])

    expect(result.outputsToAdmit).toEqual([0, 1])
  })

  it('should preserve wrapped instructions when BEEF parsing fails', async () => {
    mockTransactionFromBEEF.mockImplementation(() => { throw new Error('bad beef') })

    const result = await wrapper.identifyAdmissibleOutputs([1], [])

    expect(result.outputsToAdmit).toEqual([0, 1])
    expect(mockBanService.isOutpointBanned).not.toHaveBeenCalled()
  })

  it('should preserve wrapped instructions for non-standard outputs', async () => {
    mockPushDropDecode.mockImplementation(() => { throw new Error('bad script') })

    const result = await wrapper.identifyAdmissibleOutputs([1], [])

    expect(result.outputsToAdmit).toEqual([0, 1])
    expect(mockBanService.isDomainBanned).not.toHaveBeenCalled()
  })

  it('should delegate identifyNeededInputs', async () => {
    await expect(wrapper.identifyNeededInputs([1], [2])).resolves.toEqual([{ txid: 'needed-txid', outputIndex: 0 }])
    expect(mockWrapped.identifyNeededInputs).toHaveBeenCalledWith([1], [2])
  })

  it('should return no needed inputs when wrapped manager does not implement it', async () => {
    const manager = new BanAwareTopicManager(
      { ...mockWrapped, identifyNeededInputs: undefined },
      mockBanService,
      'SLAP',
      mockLogger
    )

    await expect(manager.identifyNeededInputs([1])).resolves.toEqual([])
  })

  it('should delegate documentation and metadata', async () => {
    await expect(wrapper.getDocumentation()).resolves.toBe('docs')
    await expect(wrapper.getMetaData()).resolves.toEqual({ name: 'test', shortDescription: 'test' })
  })
})
