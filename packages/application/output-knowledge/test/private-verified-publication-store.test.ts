import { spawnSync } from 'node:child_process'
import { protectedValue } from '../src/private/ProtectedLedgerCodec.js'
import { expect, it } from '@jest/globals'
import { advancePrivatePublicationProgress } from '../src/private/PrivatePublicationProgress.js'
import { createPrivatePublicationRecords } from '../src/private/PrivatePublicationRecords.js'
import { verifiedFixture } from './private-verified-publication-fixture.js'
import { allow } from './private-publication-fixture.js'
import { privatePublicationOperation } from '../src/private/PrivatePublicationProgress.js'

function admission(
  state: ReturnType<ReturnType<typeof verifiedFixture>['stage']>,
  included = true
) {
  return {
    operationId: privatePublicationOperation(state),
    txid: state.txid,
    assessmentContextId: 'original-private-admission',
    steak: {
      [state.topic]: {
        outputsToAdmit: included ? [state.outputIndex] : [],
        coinsToRetain: []
      }
    }
  }
}
function reserveAndAdmit(f: ReturnType<typeof verifiedFixture>, state: ReturnType<typeof f.stage>) {
  let loaded = f.store.loadVerified(state.publicationId, () => '21', allow)!
  f.store.advance(
    state.publicationId,
    loaded.record.revision,
    { kind: 'reserve-admission' },
    () => '21',
    allow
  )
  loaded = f.store.loadVerified(state.publicationId, () => '22', allow)!
  f.store.advance(
    state.publicationId,
    loaded.record.revision,
    { kind: 'admitted', admission: admission(state) },
    () => '22',
    allow
  )
}
it('closes independently reopened transient readers after both successful and failed reads', () => {
  const f = verifiedFixture(),
    state = f.stage(),
    retained = f.retainedOwners()
  const result = f.readReopened(reader => {
    expect(reader).not.toBe(f.store)
    expect(f.retainedOwners()).toBe(retained + 1)
    return reader.loadVerified(state.publicationId, () => '20', allow)!
  })
  expect(result.fence.state).toEqual(state)
  expect(result.original).toEqual(f.contract.record)
  expect(f.retainedOwners()).toBe(retained)
  expect(() =>
    f.readReopened(reader => {
      expect(reader.loadVerified(state.publicationId, () => '20', allow)).not.toBeNull()
      throw new Error('Transient read failed')
    })
  ).toThrow('Transient read failed')
  expect(f.retainedOwners()).toBe(retained)
  expect(f.store.loadVerified(state.publicationId, () => '20', allow)!.fence.state).toEqual(state)
})
it('atomically stores blob, original verified fence and inactive lookup binding across independent reopen', () => {
  const f = verifiedFixture(),
    state = f.stage()
  const loaded = f.reopen().loadVerified(state.publicationId, () => '20', allow)!
  expect(loaded.fence.format).toBe('private-publication-fence/2')
  expect(loaded.original).toEqual(f.contract.record)
  expect(loaded.binding.phase).toBe('reserved')
  expect(loaded.record.revision).toBe('1')
  expect(loaded.bindingRecord.revision).toBe('1')
  expect(loaded.bindingRecord.reservedUpdates).toBe(1)
  expect(f.native.rows().map(row => row.kind)).toEqual([
    'publication',
    'publication',
    'request-fence'
  ])
})
it('rolls back all three reservations when authorization is revoked at physical commit', () => {
  const f = verifiedFixture()
  let gates = 0
  expect(() =>
    f.store.stageVerified(
      f.contract.request,
      f.selected,
      '30',
      f.contract.record,
      () => '20',
      () => {
        if (++gates === 2) throw new Error('revoked')
      }
    )
  ).toThrow('revoked')
  expect(f.native.rows()).toHaveLength(0)
})
it('activates the exact native binding and ready fence in one durable revision', () => {
  const f = verifiedFixture(),
    state = f.stage()
  reserveAndAdmit(f, state)
  const before = f.reopen().loadVerified(state.publicationId, () => '22', allow)!
  expect(before.binding.phase).toBe('reserved')
  const ready = f.store.bindVerified(state.publicationId, before.record.revision, () => '23', allow)
  expect(ready.progress.phase).toBe('ready')
  const after = f.reopen().loadVerified(state.publicationId, () => '23', allow)!
  expect(after.binding.phase).toBe('active')
  expect(after.record.revision).toBe('4')
  expect(after.revision).toBe('4')
  expect(after.bindingRecord.revision).toBe('2')
  expect(after.bindingRecord.reservedUpdates).toBe(0)
  expect(after.fence.state).toEqual(ready)
})
it('cannot mark verified state ready with a caller-provided synthetic lookup receipt', () => {
  const f = verifiedFixture(),
    state = f.stage()
  reserveAndAdmit(f, state)
  const loaded = f.store.loadVerified(state.publicationId, () => '22', allow)!
  expect(() =>
    f.store.advance(
      state.publicationId,
      loaded.record.revision,
      {
        kind: 'bound',
        binding: {
          publicationId: state.publicationId,
          requestDigest: state.requestDigest,
          blobKey: state.blobKey,
          ...state.lookup,
          receiptDigest: '55'.repeat(32)
        }
      },
      () => '23',
      allow
    )
  ).toThrow(expect.objectContaining({ code: 'unsupported' }))
  expect(f.reopen().loadVerified(state.publicationId, () => '23', allow)!.binding.phase).toBe(
    'reserved'
  )
})
it('rolls back native binding activation and readiness together after commit-time revocation', () => {
  const f = verifiedFixture(),
    state = f.stage()
  reserveAndAdmit(f, state)
  const before = f.store.loadVerified(state.publicationId, () => '22', allow)!
  let gates = 0
  expect(() =>
    f.store.bindVerified(
      state.publicationId,
      before.record.revision,
      () => '23',
      () => {
        if (++gates === 4) throw new Error('revoked')
      }
    )
  ).toThrow('revoked')
  const after = f.reopen().loadVerified(state.publicationId, () => '23', allow)!
  expect(after.fence.state.progress.phase).toBe('binding')
  expect(after.binding.phase).toBe('reserved')
  expect(after.record.revision).toBe(before.record.revision)
  expect(after.bindingRecord.revision).toBe(before.bindingRecord.revision)
})
it('retries preserve the original contract and cannot fabricate service history for a legacy fence', () => {
  const f = verifiedFixture(),
    state = f.stage()
  expect(
    f
      .reopen()
      .stageVerified(f.contract.request, f.selected, '100', f.contract.record, () => '50', allow)
  ).toEqual(state)
  expect(f.native.rows()).toHaveLength(3)
  const old = verifiedFixture()
  old.native.store.stage(old.contract.request, old.selected, '30', () => '20', allow)
  expect(() => old.stage()).toThrow(expect.objectContaining({ code: 'unavailable' }))
  expect(old.native.rows()).toHaveLength(2)
})
it('shared exact blobs and bindings keep separate request fences and readiness receipts', () => {
  const f = verifiedFixture(),
    first = f.stage()
  reserveAndAdmit(f, first)
  const one = f.store.bindVerified(
    first.publicationId,
    f.store.loadVerified(first.publicationId, () => '23', allow)!.record.revision,
    () => '23',
    allow
  )
  const request = {
    ...f.contract.request,
    requestId: 'verified-publication-second'
  }
  const pair = createPrivatePublicationRecords(
    request,
    f.native.owner.identity,
    { ...f.selected, chain: f.configuration.identity.chain },
    '23',
    '30'
  )
  const original = {
    ...f.contract.record,
    publicationId: pair.fence.state.publicationId,
    requestDigest: pair.fence.state.requestDigest
  }
  const second = f.store.stageVerified(request, f.selected, '30', original, () => '23', allow)
  reserveAndAdmit(f, second)
  const two = f.store.bindVerified(
    second.publicationId,
    f.store.loadVerified(second.publicationId, () => '24', allow)!.record.revision,
    () => '24',
    allow
  )
  expect(f.native.rows()).toHaveLength(4)
  expect(one.progress.phase).toBe('ready')
  expect(two.progress.phase).toBe('ready')
  if (one.progress.phase !== 'ready' || two.progress.phase !== 'ready')
    throw new Error('Expected ready')
  expect(one.progress.binding.receiptDigest).not.toBe(two.progress.binding.receiptDigest)
  expect(
    f.store.loadVerified(second.publicationId, () => '24', allow)!.bindingRecord.revision
  ).toBe('2')
})
it('stale native workers cannot complete the same binding revision twice', () => {
  const f = verifiedFixture(),
    state = f.stage(),
    other = f.reopen()
  reserveAndAdmit(f, state)
  const revision = f.store.loadVerified(state.publicationId, () => '23', allow)!.record.revision
  other.bindVerified(state.publicationId, revision, () => '23', allow)
  expect(() => f.store.bindVerified(state.publicationId, revision, () => '23', allow)).toThrow(
    expect.objectContaining({ code: 'conflict' })
  )
})
it('retains original active binding evidence through unavailable and verified restored states', () => {
  const f = verifiedFixture(),
    state = f.stage()
  reserveAndAdmit(f, state)
  const before = f.store.loadVerified(state.publicationId, () => '23', allow)!
  const ready = f.store.bindVerified(state.publicationId, before.record.revision, () => '23', allow)
  f.store.advance(
    state.publicationId,
    '4',
    { kind: 'unavailable', reason: 'temporary service stop' },
    () => '24',
    allow
  )
  const restored = f.reopen().bindVerified(state.publicationId, '5', () => '25', allow)
  expect(restored.progress).toEqual(ready.progress)
  expect(f.store.loadVerified(state.publicationId, () => '25', allow)!.bindingRecord.revision).toBe(
    '2'
  )
})
it('retains definitive excluded admission without activating private availability', () => {
  const f = verifiedFixture(),
    state = f.stage()
  f.store.advance(state.publicationId, '1', { kind: 'reserve-admission' }, () => '21', allow)
  const excluded = f.store.advance(
    state.publicationId,
    '2',
    {
      kind: 'excluded',
      admission: admission(state, false),
      reason: 'selected output excluded'
    },
    () => '100',
    allow
  )
  expect(excluded.progress.phase).toBe('excluded')
  const loaded = f.reopen().loadVerified(state.publicationId, () => '100', allow)!
  expect(loaded.binding.phase).toBe('reserved')
  expect(() =>
    f.store.bindVerified(state.publicationId, loaded.record.revision, () => '101', allow)
  ).toThrow(expect.objectContaining({ code: 'conflict' }))
  expect(() =>
    advancePrivatePublicationProgress(excluded, { kind: 'expired', reason: 'late' }, '101')
  ).toThrow()
})

it.each(['staged', 'admitting', 'binding', 'ready', 'unavailable'] as const)(
  'recovers the exact verified %s state after actual process loss',
  phase => {
    const f = verifiedFixture()
    const domainURL = new URL('../dist/private/PrivateServiceDomain.js', import.meta.url).href
    const payloadURL = new URL('../dist/private/NodeProtectedPayloadCodec.js', import.meta.url).href
    const storeURL = new URL('../dist/private/SQLitePrivatePublicationStore.js', import.meta.url)
      .href
    const contractsURL = new URL('../dist/private/PrivatePublicationContracts.js', import.meta.url)
      .href
    const progressURL = new URL('../dist/private/PrivatePublicationProgress.js', import.meta.url)
      .href
    const script = `import { createSecretKey } from 'node:crypto';
      import { PrivateServiceDomain } from ${JSON.stringify(domainURL)};
      import { NodeProtectedPayloadCodec } from ${JSON.stringify(payloadURL)};
      import { SQLitePrivatePublicationStore } from ${JSON.stringify(storeURL)};
      import { PrivatePublicationContracts } from ${JSON.stringify(contractsURL)};
      import { privatePublicationOperation } from ${JSON.stringify(progressURL)};
      const owner=PrivateServiceDomain.open(${JSON.stringify(f.native.path)},${JSON.stringify(f.configuration)},
        {resolve:()=>createSecretKey(Buffer.alloc(32,101))},
        new NodeProtectedPayloadCodec({resolve:()=>createSecretKey(Buffer.alloc(32,102))},'payload'));
      const contracts=new PrivatePublicationContracts(${JSON.stringify(f.contract.installation)},
        {maximumAgeSeconds:'100',clockSkewSeconds:'1',rules:new Map([['urn:test:private-rules',()=>{}]])});
      const store=new SQLitePrivatePublicationStore(owner,{maximumBlobBytes:4096,maximumFenceBytes:131072,supportedExtensions:[]},
        {contracts,validationPolicy:${JSON.stringify(f.contract.policy)},lookup:${JSON.stringify(f.service.lookup)},
          maximumBindingBytes:8192,maximumOutcomeBytes:4096});
      let state=store.stageVerified(${JSON.stringify(f.contract.request)},${JSON.stringify(f.selected)},'30',
        ${JSON.stringify(f.contract.record)},()=> '20',()=>{});
      if(${JSON.stringify(phase)}!=='staged')state=store.advance(state.publicationId,'1',{kind:'reserve-admission'},()=> '21',()=>{});
      if(['binding','ready','unavailable'].includes(${JSON.stringify(phase)}))state=store.advance(state.publicationId,'2',{
        kind:'admitted',admission:{operationId:privatePublicationOperation(state),txid:state.txid,
          assessmentContextId:'original-private-admission',steak:{[state.topic]:{outputsToAdmit:[state.outputIndex],coinsToRetain:[]}}}},()=> '22',()=>{});
      if(['ready','unavailable'].includes(${JSON.stringify(phase)}))state=store.bindVerified(state.publicationId,'3',()=> '23',()=>{});
      if(${JSON.stringify(phase)}==='unavailable')state=store.advance(state.publicationId,'4',{kind:'unavailable',reason:'service stopped'},()=> '24',()=>{});
      process.kill(process.pid,'SIGKILL');`
    const child = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
      encoding: 'utf8',
      timeout: 15000
    })
    expect(child.error).toBeUndefined()
    expect(child.signal).toBe('SIGKILL')
    const recovered = f.reopen().loadVerified(f.contract.record.publicationId, () => '100', allow)!
    expect(recovered.fence.state.progress.phase).toBe(phase)
    expect(recovered.original).toEqual(f.contract.record)
    expect(recovered.binding.phase).toBe(
      ['ready', 'unavailable'].includes(phase) ? 'active' : 'reserved'
    )
  }
)

it('keeps a verified publication pending when its protected lookup contract is inconsistent', () => {
  const f = verifiedFixture(),
    state = f.stage()
  reserveAndAdmit(f, state)
  const before = f.store.loadVerified(state.publicationId, () => '22', allow)!
  const altered = {
    ...before.binding,
    lookup: { ...before.binding.lookup, service: 'ls_unrelated' }
  }
  f.native.owner.ledger.commit(
    before.revision,
    [
      {
        kind: before.bindingRecord.kind,
        key: before.bindingRecord.key,
        reservedBytes: before.bindingRecord.reservedBytes,
        reservedUpdates: before.bindingRecord.reservedUpdates,
        expectedRevision: before.bindingRecord.revision,
        value: protectedValue(altered, before.bindingRecord.reservedBytes).value
      }
    ],
    () => '22',
    allow
  )
  expect(() => f.reopen().loadVerified(state.publicationId, () => '23', allow)).toThrow(
    expect.objectContaining({ code: 'unavailable' })
  )
  expect(
    f.native.store.load(state.publicationId, () => '23', allow)!.fence.state.progress.phase
  ).toBe('binding')
})
it('rejects altered private bytes for a shared verified publication before adding another fence', () => {
  const f = verifiedFixture(),
    state = f.stage()
  const request = { ...f.contract.request, requestId: 'changed-shared-blob', privateValues: 'BAUG' }
  const prepared = createPrivatePublicationRecords(
    request,
    f.native.owner.identity,
    { ...f.selected, chain: f.configuration.identity.chain },
    '20',
    '30'
  )
  const original = {
    ...f.contract.record,
    publicationId: prepared.fence.state.publicationId,
    requestDigest: prepared.fence.state.requestDigest
  }
  expect(() =>
    f.store.stageVerified(request, f.selected, '30', original, () => '21', allow)
  ).toThrow(expect.objectContaining({ code: 'conflict' }))
  expect(f.native.rows()).toHaveLength(3)
  expect(f.reopen().loadVerified(state.publicationId, () => '21', allow)!.request).toEqual(
    f.contract.request
  )
})
it('does not replace a retained original capability with a later valid contract on an exact retry', () => {
  const f = verifiedFixture(),
    state = f.stage()
  const record = structuredClone(f.contract.record)
  record.capability.selectedAt = '21'
  const retry = f.store.stageVerified(
    f.contract.request,
    f.selected,
    '100',
    record,
    () => '22',
    allow
  )
  expect(retry).toEqual(state)
  expect(f.reopen().loadVerified(state.publicationId, () => '22', allow)!.original).toEqual(
    f.contract.record
  )
})
