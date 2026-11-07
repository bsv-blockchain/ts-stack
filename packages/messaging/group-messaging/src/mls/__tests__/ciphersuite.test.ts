import { beforeEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_CIPHERSUITE } from '../../types.js'

const getCiphersuiteImpl = vi.fn()

vi.mock('ts-mls', () => ({
  getCiphersuiteFromName: (name: string) => name,
  getCiphersuiteImpl
}))

const { resolveCiphersuite } = await import('../ciphersuite.js')

describe('resolveCiphersuite', () => {
  beforeEach(() => {
    getCiphersuiteImpl.mockReset()
  })

  it('builds the implementation once for concurrent callers', async () => {
    getCiphersuiteImpl.mockResolvedValue({ name: DEFAULT_CIPHERSUITE })

    const [first, second] = await Promise.all([
      resolveCiphersuite(DEFAULT_CIPHERSUITE),
      resolveCiphersuite(DEFAULT_CIPHERSUITE)
    ])

    expect(first).toBe(second)
    expect(getCiphersuiteImpl).toHaveBeenCalledTimes(1)
  })

  it('retries after a failed build rather than caching the rejection', async () => {
    getCiphersuiteImpl.mockRejectedValueOnce(new Error('wasm unavailable'))
    getCiphersuiteImpl.mockResolvedValue({ name: 'MLS_128_DHKEMP256_AES128GCM_SHA256_P256' })

    await expect(resolveCiphersuite('MLS_128_DHKEMP256_AES128GCM_SHA256_P256')).rejects.toThrow(
      'wasm unavailable'
    )

    const retried = await resolveCiphersuite('MLS_128_DHKEMP256_AES128GCM_SHA256_P256')

    expect(retried.name).toBe('MLS_128_DHKEMP256_AES128GCM_SHA256_P256')
    expect(getCiphersuiteImpl).toHaveBeenCalledTimes(2)
  })
})
