import { describe, it, expect, jest, beforeEach } from '@jest/globals'
import { BanAwareLookupWrapper } from '../BanAwareLookupWrapper.js'
import { BanService } from '../BanService.js'
import { LookupService, OutputAdmittedByTopic } from '@bsv/overlay'
import { PushDrop, Utils, Script } from '@bsv/sdk'

jest.mock('@bsv/sdk', () => ({
  PushDrop: {
    decode: jest.fn()
  },
  Utils: {
    toUTF8: jest.fn()
  },
  Script: jest.fn()
}))

// After jest.mock hoisting, these imports reference the mocked versions
const mockPushDropDecode = PushDrop.decode as unknown as jest.Mock<any>
const mockToUTF8 = Utils.toUTF8 as unknown as jest.Mock<any>

describe('BanAwareLookupWrapper', () => {
  let wrapper: BanAwareLookupWrapper
  let mockWrapped: jest.Mocked<LookupService>
  let mockBanService: jest.Mocked<BanService>
  let mockLogger: any

  beforeEach(() => {
    jest.clearAllMocks()

    mockWrapped = {
      admissionMode: 'locking-script',
      spendNotificationMode: 'locking-script',
      outputAdmittedByTopic: jest.fn<any>().mockResolvedValue(undefined),
      outputSpent: jest.fn<any>().mockResolvedValue(undefined),
      outputNoLongerRetainedInHistory: jest.fn<any>().mockResolvedValue(undefined),
      outputEvicted: jest.fn<any>().mockResolvedValue(undefined),
      lookup: jest.fn<any>().mockResolvedValue({ type: 'output-list', outputs: [] }),
      getDocumentation: jest.fn<any>().mockResolvedValue('docs'),
      getMetaData: jest.fn<any>().mockResolvedValue({ name: 'test', shortDescription: 'test' })
    } as any

    mockBanService = {
      isOutpointBanned: jest.fn<any>().mockResolvedValue(false),
      isDomainBanned: jest.fn<any>().mockResolvedValue(false),
      banDomain: jest.fn<any>().mockResolvedValue(undefined),
      banOutpoint: jest.fn<any>().mockResolvedValue(undefined)
    } as any

    mockLogger = {
      log: jest.fn(),
      error: jest.fn(),
      warn: jest.fn()
    }

    wrapper = new BanAwareLookupWrapper(mockWrapped, mockBanService, 'SHIP', mockLogger)
  })

  describe('constructor', () => {
    it('should copy admissionMode and spendNotificationMode from wrapped service', () => {
      expect(wrapper.admissionMode).toBe('locking-script')
      expect(wrapper.spendNotificationMode).toBe('locking-script')
    })
  })

  describe('outputAdmittedByTopic', () => {
    it('should block a banned outpoint', async () => {
      mockBanService.isOutpointBanned.mockResolvedValue(true)

      const payload: OutputAdmittedByTopic = {
        mode: 'locking-script',
        txid: 'banned-txid',
        outputIndex: 0,
        topic: 'tm_ship',
        satoshis: 1,
        lockingScript: new Script()
      }

      await wrapper.outputAdmittedByTopic(payload)

      expect(mockBanService.isOutpointBanned).toHaveBeenCalledWith('banned-txid', 0)
      expect(mockWrapped.outputAdmittedByTopic).not.toHaveBeenCalled()
      expect(mockLogger.log).toHaveBeenCalledWith(expect.stringContaining('[BAN]'))
    })

    it('should block a banned domain parsed from PushDrop fields', async () => {
      mockBanService.isOutpointBanned.mockResolvedValue(false)
      mockBanService.isDomainBanned.mockResolvedValue(true)

      mockPushDropDecode.mockReturnValue({
        fields: [Buffer.from('field0'), Buffer.from('field1'), Buffer.from('https://banned.com')]
      })
      mockToUTF8.mockReturnValue('https://banned.com')

      const payload: OutputAdmittedByTopic = {
        mode: 'locking-script',
        txid: 'some-txid',
        outputIndex: 1,
        topic: 'tm_ship',
        satoshis: 1,
        lockingScript: new Script()
      }

      await wrapper.outputAdmittedByTopic(payload)

      expect(mockBanService.isDomainBanned).toHaveBeenCalledWith('https://banned.com')
      expect(mockWrapped.outputAdmittedByTopic).not.toHaveBeenCalled()
      expect(mockLogger.log).toHaveBeenCalledWith(expect.stringContaining('banned domain'))
    })

    it('should delegate to wrapped service when not banned', async () => {
      mockBanService.isOutpointBanned.mockResolvedValue(false)
      mockBanService.isDomainBanned.mockResolvedValue(false)

      mockPushDropDecode.mockReturnValue({
        fields: [Buffer.from('f0'), Buffer.from('f1'), Buffer.from('https://good.com')]
      })
      mockToUTF8.mockReturnValue('https://good.com')

      const payload: OutputAdmittedByTopic = {
        mode: 'locking-script',
        txid: 'good-txid',
        outputIndex: 0,
        topic: 'tm_ship',
        satoshis: 1,
        lockingScript: new Script()
      }

      await wrapper.outputAdmittedByTopic(payload)

      expect(mockWrapped.outputAdmittedByTopic).toHaveBeenCalledWith(payload)
    })

    it('should delegate to wrapped service when PushDrop decode fails', async () => {
      mockBanService.isOutpointBanned.mockResolvedValue(false)

      mockPushDropDecode.mockImplementation(() => { throw new Error('Invalid script') })

      const payload: OutputAdmittedByTopic = {
        mode: 'locking-script',
        txid: 'weird-txid',
        outputIndex: 0,
        topic: 'tm_ship',
        satoshis: 1,
        lockingScript: new Script()
      }

      await wrapper.outputAdmittedByTopic(payload)

      expect(mockWrapped.outputAdmittedByTopic).toHaveBeenCalledWith(payload)
    })

    it('should delegate to wrapped service when PushDrop has fewer than 3 fields', async () => {
      mockBanService.isOutpointBanned.mockResolvedValue(false)

      mockPushDropDecode.mockReturnValue({ fields: [Buffer.from('f0'), Buffer.from('f1')] })

      const payload: OutputAdmittedByTopic = {
        mode: 'locking-script',
        txid: 'short-txid',
        outputIndex: 0,
        topic: 'tm_ship',
        satoshis: 1,
        lockingScript: new Script()
      }

      await wrapper.outputAdmittedByTopic(payload)

      expect(mockBanService.isDomainBanned).not.toHaveBeenCalled()
      expect(mockWrapped.outputAdmittedByTopic).toHaveBeenCalledWith(payload)
    })

    it('should delegate directly when mode is not locking-script', async () => {
      const payload = {
        mode: 'previous-output',
        txid: 'any-txid',
        outputIndex: 0,
        topic: 'tm_ship'
      } as any

      await wrapper.outputAdmittedByTopic(payload)

      expect(mockBanService.isOutpointBanned).not.toHaveBeenCalled()
      expect(mockWrapped.outputAdmittedByTopic).toHaveBeenCalledWith(payload)
    })
  })

  describe('outputSpent', () => {
    it('should delegate to wrapped service', async () => {
      const payload = { txid: 'spent-txid', outputIndex: 0, topic: 'tm_ship' } as any

      await wrapper.outputSpent(payload)

      expect(mockWrapped.outputSpent).toHaveBeenCalledWith(payload)
    })

    it('should handle wrapped service without outputSpent', async () => {
      const wrappedWithout = { ...mockWrapped, outputSpent: undefined } as any
      const w = new BanAwareLookupWrapper(wrappedWithout, mockBanService, 'SHIP', mockLogger)

      // Should not throw
      await w.outputSpent({ txid: 't', outputIndex: 0, topic: 'x' } as any)
    })
  })

  describe('outputNoLongerRetainedInHistory', () => {
    it('should delegate to wrapped service', async () => {
      await wrapper.outputNoLongerRetainedInHistory('txid', 0, 'topic')

      expect(mockWrapped.outputNoLongerRetainedInHistory).toHaveBeenCalledWith('txid', 0, 'topic')
    })

    it('should handle wrapped service without the method', async () => {
      const wrappedWithout = { ...mockWrapped, outputNoLongerRetainedInHistory: undefined } as any
      const w = new BanAwareLookupWrapper(wrappedWithout, mockBanService, 'SLAP', mockLogger)

      await w.outputNoLongerRetainedInHistory('txid', 0, 'topic')
    })
  })

  describe('outputEvicted', () => {
    it('should delegate to wrapped service', async () => {
      await wrapper.outputEvicted('txid', 0)

      expect(mockWrapped.outputEvicted).toHaveBeenCalledWith('txid', 0)
    })
  })

  describe('lookup', () => {
    it('should delegate to wrapped service', async () => {
      const question = { service: 'ls_ship', query: {} }

      await wrapper.lookup(question as any)

      expect(mockWrapped.lookup).toHaveBeenCalledWith(question)
    })
  })

  describe('getDocumentation', () => {
    it('should delegate to wrapped service', async () => {
      const result = await wrapper.getDocumentation()

      expect(result).toBe('docs')
      expect(mockWrapped.getDocumentation).toHaveBeenCalled()
    })
  })

  describe('getMetaData', () => {
    it('should delegate to wrapped service', async () => {
      const result = await wrapper.getMetaData()

      expect(result).toEqual({ name: 'test', shortDescription: 'test' })
      expect(mockWrapped.getMetaData).toHaveBeenCalled()
    })
  })
})
