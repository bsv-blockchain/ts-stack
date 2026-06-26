import { DstasLookupService } from '../DstasLookupService'
import type { DstasStorageManager } from '../DstasStorageManager'
import type { UTXOReference } from '../types'

// A stub storage that records the arguments each finder was called with, so we
// can assert the lookup service threads the optional `frozen` filter through.
function stubStorage () {
  const calls: Array<{ method: string, args: unknown[] }> = []
  const ref: UTXOReference[] = [{ txid: 'aa'.repeat(32), outputIndex: 0 }]
  const storage = {
    async findByTokenId (tokenId: string, frozen?: boolean) { calls.push({ method: 'findByTokenId', args: [tokenId, frozen] }); return ref },
    async findByOwner (ownerHash160: string, frozen?: boolean) { calls.push({ method: 'findByOwner', args: [ownerHash160, frozen] }); return ref },
    async findByOutpoint (txid: string, outputIndex: number) { calls.push({ method: 'findByOutpoint', args: [txid, outputIndex] }); return ref }
  } as unknown as DstasStorageManager
  return { storage, calls }
}

describe('DstasLookupService frozen filter', () => {
  it('passes frozen=false through an owner query', async () => {
    const { storage, calls } = stubStorage()
    const svc = new DstasLookupService({ storage })
    await svc.lookup({ service: 'ls_dstas', query: { ownerHash160: 'ab'.repeat(20), frozen: false } } as any)
    expect(calls).toEqual([{ method: 'findByOwner', args: ['ab'.repeat(20), false] }])
  })

  it('passes frozen=true through a tokenId query', async () => {
    const { storage, calls } = stubStorage()
    const svc = new DstasLookupService({ storage })
    await svc.lookup({ service: 'ls_dstas', query: { tokenId: 'cd'.repeat(20), frozen: true } } as any)
    expect(calls).toEqual([{ method: 'findByTokenId', args: ['cd'.repeat(20), true] }])
  })

  it('omits the filter (undefined) when frozen is not supplied', async () => {
    const { storage, calls } = stubStorage()
    const svc = new DstasLookupService({ storage })
    await svc.lookup({ service: 'ls_dstas', query: { ownerHash160: 'ab'.repeat(20) } } as any)
    expect(calls).toEqual([{ method: 'findByOwner', args: ['ab'.repeat(20), undefined] }])
  })
})
