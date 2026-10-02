import { expect, it } from '@jest/globals'
import { spawnSync } from 'node:child_process'
import { SQLitePrivatePublicationStore } from '../src/private/SQLitePrivatePublicationStore.js'
import {
  selected,
  config,
  request,
  limits,
  allow,
  clock,
  fixture,
  staged,
  admission,
  binding
} from './private-publication-fixture.js'
it('atomically retains one protected blob and one permanent request fence across independent open', () => {
  const f = fixture(),
    state = staged(f.store)
  const loaded = f.reopen().load(state.publicationId, clock, allow)!
  expect(loaded.fence.state).toEqual(state)
  expect(loaded.request).toEqual(request())
  expect(loaded.revision).toBe('1')
  expect(f.rows().map(row => row.kind)).toEqual(['publication', 'request-fence'])
  expect(loaded.record.reservedUpdates).toBe(5)
  state.lookup.service = 'changed'
  loaded.request.privateValues = 'BA=='
  expect(f.store.load(state.publicationId, clock, allow)!.request).toEqual(request())
})
it('exact retries and proof variants recover the original intent without another revision', () => {
  const f = fixture(),
    state = staged(f.store)
  const variant = { ...request(), evidence: { ...request().evidence, beef: 'Aw==' } }
  expect(f.reopen().stage(variant, selected(), '200', () => '100', allow)).toEqual(state)
  const loaded = f.store.load(state.publicationId, clock, allow)!
  expect(loaded.revision).toBe('1')
  expect(loaded.request.evidence.beef).toBe('AQ==')
  expect(loaded.observedAt).toBe('100')
})
it('rejects changed retry semantics and changed values for a shared blob without extra fences', () => {
  const f = fixture()
  staged(f.store)
  expect(() =>
    f.store.stage({ ...request(), privateValues: 'BA==' }, selected(), '20', clock, allow)
  ).toThrow('request conflicts')
  expect(() =>
    f.store.stage(
      { ...request(), requestId: 'synthetic-publish-2', privateValues: 'BA==' },
      selected(),
      '20',
      clock,
      allow
    )
  ).toThrow('blob conflicts')
  expect(f.rows()).toHaveLength(2)
})
it('uses one shared protected blob for two independently fenced request IDs', () => {
  const f = fixture(),
    first = staged(f.store)
  const second = f.store.stage(
    { ...request(), requestId: 'synthetic-publish-2' },
    selected(),
    '20',
    clock,
    allow
  )
  expect(second.publicationId).not.toBe(first.publicationId)
  expect(second.blobKey).toBe(first.blobKey)
  expect(f.rows().map(row => row.kind)).toEqual(['publication', 'request-fence', 'request-fence'])
})
it('persists admission reservation before effects and recovers late original admission and binding', () => {
  const f = fixture(),
    state = staged(f.store)
  const reserved = f.store.advance(
    state.publicationId,
    '1',
    { kind: 'reserve-admission' },
    () => '11',
    allow
  )
  expect(f.reopen().load(state.publicationId, clock, allow)!.fence.state).toEqual(reserved)
  const admitted = f
    .reopen()
    .advance(
      state.publicationId,
      '2',
      { kind: 'admitted', admission: admission(state) },
      () => '100',
      allow
    )
  expect(admitted.progress.phase).toBe('binding')
  const ready = f.store.advance(
    state.publicationId,
    '3',
    { kind: 'bound', binding: binding(state) },
    () => '101',
    allow
  )
  expect(f.reopen().load(state.publicationId, clock, allow)!.fence.state).toEqual(ready)
  expect(ready.progress.phase).toBe('ready')
  const unavailable = f.store.advance(
    state.publicationId,
    '4',
    { kind: 'unavailable', reason: 'lookup unavailable' },
    () => '102',
    allow
  )
  expect(unavailable.progress.phase).toBe('unavailable')
  const restored = f
    .reopen()
    .advance(
      state.publicationId,
      '5',
      { kind: 'restored', binding: binding(state) },
      () => '103',
      allow
    )
  expect(restored.progress.phase).toBe('ready')
})
it('prevents stale independent workers from reserving or advancing the same phase twice', () => {
  const f = fixture(),
    second = f.reopen(),
    state = staged(f.store)
  second.advance(state.publicationId, '1', { kind: 'reserve-admission' }, () => '11', allow)
  expect(() =>
    f.store.advance(state.publicationId, '1', { kind: 'reserve-admission' }, () => '12', allow)
  ).toThrow(expect.objectContaining({ code: 'conflict' }))
  expect(f.store.load(state.publicationId, clock, allow)!.record.revision).toBe('2')
})
it('retains terminal fences and never restarts an expired request under a new deadline', () => {
  const f = fixture(),
    state = staged(f.store)
  const expired = f.store.advance(
    state.publicationId,
    '1',
    { kind: 'expired', reason: 'staging elapsed' },
    () => '20',
    allow
  )
  expect(f.reopen().stage(request(), selected(), '200', () => '100', allow)).toEqual(expired)
  expect(() =>
    f.store.advance(state.publicationId, '2', { kind: 'reserve-admission' }, () => '100', allow)
  ).toThrow()
})
it('rolls back both new records when current authorization is revoked at the commit gate', () => {
  const f = fixture()
  let gates = 0
  expect(() =>
    f.store.stage(request(), selected(), '20', clock, () => {
      if (++gates === 2) throw new Error('revoked')
    })
  ).toThrow('revoked')
  expect(f.rows()).toHaveLength(0)
})
it('does not promise staging after the clock reaches its deadline at the commit gate', () => {
  const f = fixture()
  let reads = 0
  expect(() =>
    f.store.stage(request(), selected(), '20', () => (++reads === 1 ? '19' : '20'), allow)
  ).toThrow(expect.objectContaining({ code: 'expired' }))
  expect(f.rows()).toHaveLength(0)
})
it('rechecks admission reservation deadline inside the physical commit gate', () => {
  const f = fixture(),
    state = staged(f.store)
  let reads = 0
  expect(() =>
    f.store.advance(
      state.publicationId,
      '1',
      { kind: 'reserve-admission' },
      () => (++reads <= 2 ? '19' : '20'),
      allow
    )
  ).toThrow(expect.objectContaining({ code: 'expired' }))
  const recovered = f.reopen().load(state.publicationId, clock, allow)!
  expect(recovered.fence.state.progress.phase).toBe('staged')
  expect(recovered.observedAt).toBe('20')
})
it('reserves enough bytes for complete future progress before storing either record', () => {
  const f = fixture(),
    store = new SQLitePrivatePublicationStore(f.owner, { ...limits(), maximumFenceBytes: 4096 })
  expect(() => staged(store)).toThrow('completion does not fit')
  expect(f.rows()).toHaveLength(0)
})
it('rejects an insufficient physical record budget with no partial protected blob', () => {
  const limited = config()
  limited.capacity.maximumRecords = 1
  const f = fixture(limited)
  expect(() => staged(f.store)).toThrow(expect.objectContaining({ code: 'limited' }))
  expect(f.rows()).toHaveLength(0)
})
it('rejects async authorization before invoking its body', () => {
  const f = fixture()
  let calls = 0
  expect(() =>
    f.store.stage(request(), selected(), '20', clock, async () => {
      calls++
    })
  ).toThrow('synchronous')
  expect(calls).toBe(0)
  expect(f.rows()).toHaveLength(0)
})
it('reports an absent publication without making a new request fence', () => {
  const f = fixture()
  expect(f.store.load('00'.repeat(32), clock, allow)).toBeUndefined()
  expect(() =>
    f.store.advance('00'.repeat(32), '1', { kind: 'reserve-admission' }, clock, allow)
  ).toThrow(expect.objectContaining({ code: 'not-found' }))
  expect(f.rows()).toHaveLength(0)
})

it.each(['staged', 'admitting', 'binding', 'ready'] as const)(
  'recovers the durable %s phase after actual process loss',
  phase => {
    const f = fixture()
    const domainURL = new URL('../dist/private/PrivateServiceDomain.js', import.meta.url).href
    const payloadURL = new URL('../dist/private/NodeProtectedPayloadCodec.js', import.meta.url).href
    const storeURL = new URL('../dist/private/SQLitePrivatePublicationStore.js', import.meta.url)
      .href
    const progressURL = new URL('../dist/private/PrivatePublicationProgress.js', import.meta.url)
      .href
    const script = `import { createSecretKey } from 'node:crypto';
    import { PrivateServiceDomain } from ${JSON.stringify(domainURL)};
    import { NodeProtectedPayloadCodec } from ${JSON.stringify(payloadURL)};
    import { SQLitePrivatePublicationStore } from ${JSON.stringify(storeURL)};
    import { privatePublicationOperation } from ${JSON.stringify(progressURL)};
    const owner=PrivateServiceDomain.open(${JSON.stringify(f.path)},${JSON.stringify(config())},
      {resolve:()=>createSecretKey(Buffer.alloc(32,101))},
      new NodeProtectedPayloadCodec({resolve:()=>createSecretKey(Buffer.alloc(32,102))},'payload'));
    const store=new SQLitePrivatePublicationStore(owner,${JSON.stringify(limits())});
    let state=store.stage(${JSON.stringify(request())},${JSON.stringify(selected())},'20',()=> '10',()=>{});
    if(${JSON.stringify(phase)}!=='staged') state=store.advance(state.publicationId,'1',{kind:'reserve-admission'},()=> '11',()=>{});
    if(['binding','ready'].includes(${JSON.stringify(phase)})) state=store.advance(state.publicationId,'2',{
      kind:'admitted',admission:{operationId:privatePublicationOperation(state),txid:state.txid,assessmentContextId:'synthetic-context',
      steak:{tm_synthetic:{outputsToAdmit:[1],coinsToRetain:[]}}}},()=> '100',()=>{});
    if(${JSON.stringify(phase)}==='ready') state=store.advance(state.publicationId,'3',{kind:'bound',binding:{
      publicationId:state.publicationId,requestDigest:state.requestDigest,blobKey:state.blobKey,...state.lookup,receiptDigest:'55'.repeat(32)}},()=> '101',()=>{});
    process.kill(process.pid,'SIGKILL');`
    const child = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
      encoding: 'utf8',
      timeout: 15000
    })
    expect(child.error).toBeUndefined()
    expect(child.signal).toBe('SIGKILL')
    const restored = f.reopen().stage(request(), selected(), '200', () => '150', allow)
    expect(restored.progress.phase).toBe(phase)
    expect(f.reopen().load(restored.publicationId, clock, allow)!.request).toEqual(request())
  }
)
