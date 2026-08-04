import { describe, it, expect, jest } from '@jest/globals'
import { LookupService } from '@bsv/overlay'
import { ResourceBoundedLookupWrapper } from '../ResourceBoundedLookupWrapper.js'

const makeService = (): jest.Mocked<LookupService> =>
  ({
    admissionMode: 'locking-script',
    spendNotificationMode: 'none',
    outputAdmittedByTopic: jest.fn<any>().mockResolvedValue(undefined),
    outputSpent: jest.fn<any>().mockResolvedValue(undefined),
    outputEvicted: jest.fn<any>().mockResolvedValue(undefined),
    lookup: jest.fn<any>().mockResolvedValue([]),
    getDocumentation: jest.fn<any>().mockResolvedValue('docs'),
    getMetaData: jest.fn<any>().mockResolvedValue({ name: 'test', shortDescription: 'test' })
  }) as any

describe('ResourceBoundedLookupWrapper', () => {
  it('turns the legacy findAll query into a bounded overflow probe', async () => {
    const service = makeService()
    const wrapper = new ResourceBoundedLookupWrapper(service, 1000)

    await wrapper.lookup({ service: 'ls_ship', query: 'findAll' })

    expect(service.lookup).toHaveBeenCalledWith({
      service: 'ls_ship',
      query: { findAll: true, limit: 1001 }
    })
  })

  it('adds a bound to filtered queries that omit a limit', async () => {
    const service = makeService()
    const wrapper = new ResourceBoundedLookupWrapper(service, 50)

    await wrapper.lookup({ service: 'ls_slap', query: { service: 'message-box' } })

    expect(service.lookup).toHaveBeenCalledWith({
      service: 'ls_slap',
      query: { service: 'message-box', limit: 51 }
    })
  })

  it('caps an explicitly oversized request but preserves smaller pages', async () => {
    const service = makeService()
    const wrapper = new ResourceBoundedLookupWrapper(service, 10)

    await wrapper.lookup({ service: 'ls_ship', query: { findAll: true, limit: 100 } })
    await wrapper.lookup({ service: 'ls_ship', query: { findAll: true, limit: 4 } })

    expect(service.lookup).toHaveBeenNthCalledWith(1, {
      service: 'ls_ship',
      query: { findAll: true, limit: 11 }
    })
    expect(service.lookup).toHaveBeenNthCalledWith(2, {
      service: 'ls_ship',
      query: { findAll: true, limit: 4 }
    })
  })

  it('preserves all lookup questions when the operator selects unlimited', async () => {
    const service = makeService()
    const wrapper = new ResourceBoundedLookupWrapper(service, -1)
    const question = { service: 'ls_ship', query: 'findAll' } as const

    await wrapper.lookup(question)

    expect(service.lookup).toHaveBeenCalledWith(question)
  })

  it('rejects invalid resource limits', () => {
    expect(() => new ResourceBoundedLookupWrapper(makeService(), 0)).toThrow(TypeError)
  })
})
