import { afterEach } from '@jest/globals'
import { createSecretKey } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { outputAssert } from '@bsv/sdk'
import { NodeProtectedPayloadCodec } from '../src/private/NodeProtectedPayloadCodec.js'
import { PrivateServiceDomain } from '../src/private/PrivateServiceDomain.js'
import {
  SQLitePrivatePurchaseStore,
  type PrivatePurchaseStoreLimits
} from '../src/private/SQLitePrivatePurchaseStore.js'
import { purchaseProgressFixture } from './private-purchase-progress.fixture.js'

const cleanup = new Set<() => void>()
afterEach(() => {
  for (const dispose of cleanup) dispose()
  cleanup.clear()
})

/** Actual protected native storage with public fixture keys and unproved lifecycle-only candidate bytes. */
export function purchaseStoreFixture(
  overrides: Partial<PrivatePurchaseStoreLimits> = {},
  clockProfile?: 'native-observation-v1'
) {
  const f = purchaseProgressFixture(),
    directory = mkdtempSync(join(tmpdir(), 'private-purchase-store-')),
    path = join(directory, 'private.db'),
    index = createSecretKey(Buffer.alloc(32, 83)),
    payload = createSecretKey(Buffer.alloc(32, 84)),
    config = {
      identity: { chain: f.f.chain, seller: f.f.installation.seller },
      indexKeyId: 'index',
      capacity: {
        storeId: 'ab'.repeat(32),
        maximumRecords: 64,
        maximumReservedBytes: 4 * 1048576,
        maximumRecordBytes: 2 * 1048576
      },
      application: { profile: 'private-purchase-native-fixture/1' }
    },
    limits: PrivatePurchaseStoreLimits = {
      maximumStateBytes: 600000,
      maximumOriginalBytes: 8192,
      maximumCandidateBytes: 8192,
      maximumResultBytes: 524288,
      maximumOutcomeBytes: 1024,
      maximumBatchBytes: 1048576,
      ...overrides
    },
    policy = { id: 'urn:test:purchase-validation', digest: '99'.repeat(32) },
    custody = {
      format: 'private-purchase-custody/1' as const,
      original: f.original,
      validationPolicy: policy,
      schema: 'urn:test:private-result',
      maximumSecretBytes: 64,
      material: 'cHVibGljLXRlc3Qtc2VjcmV0'
    },
    opened = new Set<PrivateServiceDomain>()
  let now = '20',
    permitted = true
  const clock = () => now,
    guard = () => {
      outputAssert(permitted, 'Purchase recipient authority changed', 'not-found')
    }
  function open(create = false) {
    const domain = PrivateServiceDomain[create ? 'create' : 'open'](
      path,
      config,
      { resolve: () => index },
      new NodeProtectedPayloadCodec({ resolve: () => payload }, 'payload', 2 * 1048576)
    )
    opened.add(domain)
    return {
      domain,
      store: new SQLitePrivatePurchaseStore(domain, f.f.contracts, limits, policy, clockProfile)
    }
  }
  const owner = open(true),
    id = f.original.terms.body.acquisitionId,
    buyer = f.original.request.recipient,
    candidate = { version: 1 as const, acquisitionId: id, txid: f.txid, beef: 'AA==' }
  function dispose() {
    for (const domain of opened) domain.close()
    opened.clear()
    rmSync(directory, { recursive: true, force: true })
    cleanup.delete(dispose)
  }
  function close(domain: PrivateServiceDomain) {
    domain.close()
    opened.delete(domain)
  }
  cleanup.add(dispose)
  function prepare() {
    return owner.store.prepare(custody, clock, guard)
  }
  function pin() {
    const p = prepare()
    now = '29'
    return owner.store.pin(id, buyer, p.row.revision, candidate, clock, guard)
  }
  function admit() {
    const p = pin()
    now = '31'
    return owner.store.advance(
      id,
      buyer,
      p.row.revision,
      { type: 'admitted', steak: f.steak, acceptedAt: '30', assessmentContextId: 'fixture-view' },
      clock,
      guard
    )
  }
  function deliver() {
    const p = admit()
    now = '33'
    return owner.store.complete(id, buyer, p.row.revision, f.envelope(), clock, guard)
  }
  return {
    f,
    owner,
    path,
    limits,
    config,
    policy,
    custody,
    id,
    buyer,
    candidate,
    clock,
    guard,
    open,
    close,
    dispose,
    prepare,
    pin,
    admit,
    deliver,
    setNow: (value: string) => {
      now = value
    },
    setPermitted: (value: boolean) => {
      permitted = value
    }
  }
}
