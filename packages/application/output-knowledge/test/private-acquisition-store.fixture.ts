import { afterEach } from '@jest/globals'
import type { OutputChain } from '@bsv/sdk'
import { createSecretKey } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PrivateServiceDomain } from '../src/private/PrivateServiceDomain.js'
import { NodeProtectedPayloadCodec } from '../src/private/NodeProtectedPayloadCodec.js'
import { SQLitePrivateAcquisitionStore } from '../src/private/SQLitePrivateAcquisitionStore.js'
import { acquisitionRecordFixture } from './private-acquisition-records.fixture.js'

const cleanup = new Set<() => void>()
afterEach(() => {
  for (const close of cleanup) close()
  cleanup.clear()
})
export async function acquisitionStoreFixture(
  overrides: { maximumRecords?: number; maximumReservedBytes?: number } = {},
  chain?: OutputChain
) {
  const f = await acquisitionRecordFixture(chain),
    directory = mkdtempSync(join(tmpdir(), 'acquisition-store-')),
    path = join(directory, 'private.db')
  const configuration = {
    identity: { chain: f.f.chain, seller: f.f.seller },
    indexKeyId: 'index',
    capacity: {
      storeId: 'ab'.repeat(32),
      maximumRecords: 64,
      maximumReservedBytes: 16 * 1048576,
      maximumRecordBytes: 2 * 1048576,
      ...overrides
    },
    application: { profile: 'synthetic-acquisition-owner/1' }
  }
  const indexKey = createSecretKey(Buffer.alloc(32, 83)),
    payloadKey = createSecretKey(Buffer.alloc(32, 84))
  const limits = {
    maximumStateBytes: 600000,
    maximumMaterialBytes: 786433,
    maximumBatchBytes: 16 * 1048576
  }
  const owners: PrivateServiceDomain[] = []
  let now = '20'
  const clock = () => now,
    guard = () => {}
  function open(create = false) {
    const domain = PrivateServiceDomain[create ? 'create' : 'open'](
      path,
      configuration,
      { resolve: () => indexKey },
      new NodeProtectedPayloadCodec({ resolve: () => payloadKey }, 'payload')
    )
    owners.push(domain)
    return {
      domain,
      store: new SQLitePrivateAcquisitionStore(
        domain,
        {
          ...limits,
          maximumBatchBytes: Math.min(
            limits.maximumBatchBytes,
            configuration.capacity.maximumReservedBytes + 65536
          )
        },
        f.settings
      )
    }
  }
  const dispose = () => {
    for (const owner of owners) owner.close()
    rmSync(directory, { recursive: true, force: true })
    cleanup.delete(dispose)
  }
  cleanup.add(dispose)
  const owner = open(true),
    original = f.records.prepare(f.input).record
  const id = original.challenge.acquisitionId,
    buyer = original.challenge.buyer
  const quote = () => owner.store.quote(original, 'AQID', clock, guard)
  const pin = () => {
    const q = quote()
    now = '30'
    return owner.store.advance(
      id,
      buyer,
      q.row.revision,
      { type: 'pin', payment: f.f.payment() },
      clock,
      guard
    )
  }
  const reserve = () => {
    const pinned = pin()
    now = '31'
    return owner.store.advance(
      id,
      buyer,
      pinned.row.revision,
      {
        type: 'reserve-funding',
        candidateDigest: pinned.state.progress.candidate!.digest,
        sellerPaymentKey: f.f.sellerPaymentKey,
        acceptance: {
          chain: f.f.chain,
          txid: f.f.transaction.id('hex'),
          policy: { kind: 'local-admission' },
          acceptedAt: '19'
        }
      },
      clock,
      guard
    )
  }
  const fund = () => {
    const reserved = reserve()
    now = '32'
    return owner.store.advance(
      id,
      buyer,
      reserved.row.revision,
      { type: 'wallet-accepted', receipt: f.f.receipt(reserved.state.progress) },
      clock,
      guard
    )
  }
  const prepare = () => {
    const funded = fund()
    now = '33'
    return owner.store.advance(
      id,
      buyer,
      funded.row.revision,
      { type: 'prepare-delivery' },
      clock,
      guard
    )
  }
  return {
    dispose,
    f,
    path,
    configuration,
    limits,
    owner,
    open,
    original,
    id,
    buyer,
    clock,
    guard,
    quote,
    pin,
    reserve,
    fund,
    prepare,
    setNow: (value: string) => {
      now = value
    }
  }
}
