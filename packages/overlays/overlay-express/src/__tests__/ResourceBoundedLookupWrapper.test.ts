import { describe, it, expect, jest } from '@jest/globals'
import { LookupService } from '@bsv/overlay'
import { ResourceBoundedLookupWrapper } from '../ResourceBoundedLookupWrapper.js'

const makeService = (): jest.Mocked<LookupService> =>
  ({
    admissionMode: 'locking-script',
    spendNotificationMode: 'none',
    outputAdmittedByTopic: jest.fn<(...args: any[]) => any>().mockResolvedValue(undefined),
    outputSpent: jest.fn<(...args: any[]) => any>().mockResolvedValue(undefined),
    outputNoLongerRetainedInHistory: jest.fn<(...args: any[]) => any>().mockResolvedValue(undefined),
    outputEvicted: jest.fn<(...args: any[]) => any>().mockResolvedValue(undefined),
    lookup: jest.fn<(...args: any[]) => any>().mockResolvedValue([]),
    getDocumentation: jest.fn<(...args: any[]) => any>().mockResolvedValue('docs'),
    getMetaData: jest.fn<(...args: any[]) => any>().mockResolvedValue({ name: 'test', shortDescription: 'test' })
  }) as any

describe('ResourceBoundedLookupWrapper', () => {
  it('turns the legacy findAll query into a bounded overflow probe', async () => {
    const service = makeService()
    const wrapper = new ResourceBoundedLookupWrapper(service, 1000)

    await wrapper.lookup({ service: 'ls_ship', query: 'findAll' })

    expect(service.lookup).toHaveBeenCalledWith({
      service: 'ls_ship',
      query: { findAll: true, limit: 1000, skip: 0 }
    })
  })

  it.each([1000, 5000])('preserves an extra overflow row at the %i engine ceiling', async ceiling => {
    const service = makeService()
    const rows = Array.from({ length: ceiling + 1 }, (_, outputIndex) => ({ txid: '11'.repeat(32), outputIndex }))
    service.lookup.mockImplementation(async question => {
      const query = question.query as { limit: number, skip: number }
      expect(query.limit).toBeLessThanOrEqual(1000)
      return rows.slice(query.skip, query.skip + query.limit)
    })
    const result = await new ResourceBoundedLookupWrapper(service, ceiling).lookup({ service: 'ls_slap', query: { service: 'ls_uhrp' } })
    expect(result).toEqual(rows)
    expect(service.lookup).toHaveBeenCalledTimes(ceiling / 1000 + 1)
  })

  it('preserves filters, skip and sort across full pages without mutating input', async () => {
    const service = makeService()
    const rows = Array.from({ length: 1100 }, (_, outputIndex) => ({ txid: '11'.repeat(32), outputIndex }))
    service.lookup.mockImplementation(async question => {
      const query = question.query as { limit: number, skip: number }
      return rows.slice(query.skip, query.skip + query.limit)
    })
    const question = { service: 'ls_slap', query: { service: 'ls_uhrp', skip: 25, sortOrder: 'asc' } }
    const copy = structuredClone(question)
    expect(await new ResourceBoundedLookupWrapper(service, 1000).lookup(question)).toEqual(rows.slice(25, 1026))
    expect(service.lookup).toHaveBeenLastCalledWith({ service: 'ls_slap', query: { service: 'ls_uhrp', skip: 1025, sortOrder: 'asc', limit: 1 } })
    expect(question).toEqual(copy)
  })

  it('fails rather than truncating when pagination crosses the maximum skip', async () => {
    const service = makeService()
    service.lookup.mockResolvedValue(Array.from({ length: 1000 }, (_, outputIndex) => ({ txid: '11'.repeat(32), outputIndex })))
    await expect(new ResourceBoundedLookupWrapper(service, 1000).lookup({ service: 'ls_slap', query: { service: 'ls_uhrp', skip: 1_000_000 } })).rejects.toThrow(RangeError)
    expect(service.lookup).toHaveBeenCalledTimes(1)
  })

  it('rejects an oversized or non-array discovery page', async () => {
    for (const page of [Array(1001).fill({ txid: '11'.repeat(32), outputIndex: 0 }), { type: 'output-list' }]) {
      const service = makeService()
      service.lookup.mockResolvedValue(page as never)
      await expect(new ResourceBoundedLookupWrapper(service, 1000).lookup({ service: 'ls_slap', query: { service: 'ls_uhrp' } })).rejects.toThrow('invalid bounded page')
      expect(service.lookup).toHaveBeenCalledTimes(1)
    }
  })

  it('passes malformed skip to the strict service validator without pagination', async () => {
    const service = makeService()
    service.lookup.mockRejectedValue(new Error('query.skip'))
    await expect(new ResourceBoundedLookupWrapper(service, 1000).lookup({ service: 'ls_slap', query: { service: 'ls_uhrp', skip: '1' } })).rejects.toThrow('query.skip')
    expect(service.lookup).toHaveBeenCalledTimes(1)
    expect(service.lookup).toHaveBeenCalledWith({ service: 'ls_slap', query: { service: 'ls_uhrp', skip: '1', limit: 1001 } })
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

  it('delegates lifecycle notifications and service metadata', async () => {
    const service = makeService()
    const wrapper = new ResourceBoundedLookupWrapper(service, 10)
    const admitted = { txid: '01', outputIndex: 0, topic: 'tm_test' } as any
    const spent = { txid: '01', outputIndex: 0, topic: 'tm_test' } as any

    await wrapper.outputAdmittedByTopic(admitted)
    await wrapper.outputSpent(spent)
    await wrapper.outputNoLongerRetainedInHistory('01', 0, 'tm_test')
    await wrapper.outputEvicted('01', 0)

    expect(service.outputAdmittedByTopic).toHaveBeenCalledWith(admitted)
    expect(service.outputSpent).toHaveBeenCalledWith(spent)
    expect(service.outputNoLongerRetainedInHistory).toHaveBeenCalledWith('01', 0, 'tm_test')
    expect(service.outputEvicted).toHaveBeenCalledWith('01', 0)
    await expect(wrapper.getDocumentation()).resolves.toBe('docs')
    await expect(wrapper.getMetaData()).resolves.toEqual({ name: 'test', shortDescription: 'test' })
  })

  it('supports legacy services with optional notification hooks omitted', async () => {
    const service = makeService()
    delete (service as any).outputSpent
    delete (service as any).outputNoLongerRetainedInHistory
    const wrapper = new ResourceBoundedLookupWrapper(service, 10)

    await expect(wrapper.outputSpent({} as any)).resolves.toBeUndefined()
    await expect(
      wrapper.outputNoLongerRetainedInHistory('01', 0, 'tm_test')
    ).resolves.toBeUndefined()
    await expect(
      wrapper.lookup({ service: 'ls_test', query: 'custom-scalar-query' } as any)
    ).resolves.toEqual([])
  })
})
