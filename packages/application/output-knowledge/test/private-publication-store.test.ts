import { expect, it } from '@jest/globals'
import { canonicalOutputJSON } from '@bsv/sdk'
import {
  createPrivatePublicationRecords,
  privatePublicationFenceAddress
} from '../src/private/PrivatePublicationRecords.js'
import { protectedValue } from '../src/private/ProtectedLedgerCodec.js'
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
  ).toThrow(
    expect.objectContaining({
      code: 'expired',
      message: 'Private publication staging deadline has elapsed'
    })
  )
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
  ).toThrow(
    expect.objectContaining({
      code: 'expired',
      message: 'Private publication staging deadline has elapsed'
    })
  )
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
  ).toThrow(
    expect.objectContaining({ code: 'not-found', message: 'Private publication is absent' })
  )
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

it.each([null, {}, 'extension', Array.from({ length: 33 }, (_, i) => `urn:test:${i}`)])(
  'requires a bounded extension array before opening a publication reservation: %j',
  supportedExtensions => {
    const f = fixture()
    expect(
      () =>
        new SQLitePrivatePublicationStore(f.owner, {
          ...limits(),
          supportedExtensions
        } as unknown as ConstructorParameters<typeof SQLitePrivatePublicationStore>[1])
    ).toThrow(
      expect.objectContaining({
        code: 'invalid',
        message: 'Invalid private publication extensions'
      })
    )
    expect(f.rows()).toHaveLength(0)
  }
)
it.each(['', 42, null, 'x'.repeat(1025)])(
  'validates each installed extension name: %j',
  extension => {
    const f = fixture()
    expect(
      () =>
        new SQLitePrivatePublicationStore(f.owner, {
          ...limits(),
          supportedExtensions: [extension]
        } as unknown as ConstructorParameters<typeof SQLitePrivatePublicationStore>[1])
    ).toThrow()
    expect(f.rows()).toHaveLength(0)
  }
)
it('accepts all 32 supported extensions and retains their critical request semantics', () => {
  const f = fixture(),
    supportedExtensions = Array.from({ length: 32 }, (_, i) => `urn:test:${i}`)
  const store = new SQLitePrivatePublicationStore(f.owner, { ...limits(), supportedExtensions })
  const input = {
    ...request(),
    extensions: Object.fromEntries(supportedExtensions.map(name => [name, true])),
    critical: supportedExtensions
  }
  const state = store.stage(input, selected(), '20', clock, allow)
  expect(store.load(state.publicationId, clock, allow)!.request).toEqual(input)
})
it('bounds the entire installation configuration before validating its members', () => {
  const f = fixture()
  expect(
    () =>
      new SQLitePrivatePublicationStore(f.owner, {
        ...limits(),
        supportedExtensions: Array.from({ length: 32 }, () => 'x'.repeat(600))
      })
  ).toThrow(expect.objectContaining({ code: 'limited' }))
  expect(f.rows()).toHaveLength(0)
})
it('bounds the entire publisher and lookup selection before member validation or effects', () => {
  const f = fixture()
  expect(() =>
    f.store.stage(request(), { ...selected(), publisher: 'x'.repeat(16384) }, '20', clock, allow)
  ).toThrow(expect.objectContaining({ code: 'limited' }))
  expect(f.rows()).toHaveLength(0)
})
it('rejects an already elapsed staging deadline during the initial read, before another guard', () => {
  const f = fixture()
  let gates = 0
  expect(() =>
    f.store.stage(
      request(),
      selected(),
      '20',
      () => '20',
      () => {
        gates++
      }
    )
  ).toThrow(
    expect.objectContaining({
      code: 'expired',
      message: 'Private publication staging deadline has elapsed'
    })
  )
  expect(gates).toBe(1)
  expect(f.rows()).toHaveLength(0)
})
it('accepts the exact reservation for the complete future progress envelope and rejects one byte less', () => {
  const f = fixture()
  const prepared = createPrivatePublicationRecords(
    request(),
    f.owner.identity,
    { ...selected(), chain: config().identity.chain },
    '0',
    '20'
  )
  // Count the independently serialized framing and the maximum complete state.
  const bytes =
    Buffer.byteLength(canonicalOutputJSON(prepared.fence)) -
    Buffer.byteLength(canonicalOutputJSON(prepared.fence.state)) +
    65536
  const tooSmall = new SQLitePrivatePublicationStore(f.owner, {
    ...limits(),
    maximumFenceBytes: bytes - 1
  })
  expect(() => staged(tooSmall)).toThrow(
    expect.objectContaining({
      code: 'limited',
      message: 'Private publication completion does not fit its reservation'
    })
  )
  expect(f.rows()).toHaveLength(0)
  const exact = new SQLitePrivatePublicationStore(f.owner, {
    ...limits(),
    maximumFenceBytes: bytes
  })
  const state = staged(exact)
  expect(exact.load(state.publicationId, clock, allow)!.record.reservedBytes).toBe(bytes)
})
it.each(['request', 'blob'] as const)(
  'preserves typed %s retry conflicts and the original records',
  conflict => {
    const f = fixture(),
      state = staged(f.store)
    const input = {
      ...request(),
      privateValues: 'BA==',
      ...(conflict === 'blob' ? { requestId: 'synthetic-publish-2' } : {})
    }
    expect(() => f.store.stage(input, selected(), '20', clock, allow)).toThrow(
      expect.objectContaining({
        code: 'conflict',
        message: `Private publication ${conflict} conflicts`
      })
    )
    expect(f.reopen().load(state.publicationId, clock, allow)!.request).toEqual(request())
    expect(f.rows()).toHaveLength(2)
  }
)
it('refuses a retained fence whose protected blob is absent, both on retry and load', () => {
  const f = fixture()
  const prepared = createPrivatePublicationRecords(
    request(),
    f.owner.identity,
    { ...selected(), chain: config().identity.chain },
    '10',
    '20'
  )
  const address = privatePublicationFenceAddress(
    f.owner.identity,
    prepared.fence.state.publicationId
  )
  f.owner.ledger.commit(
    '0',
    [
      {
        ...address,
        expectedRevision: null,
        reservedBytes: 131072,
        reservedUpdates: 5,
        value: protectedValue(prepared.fence, 131072).value
      }
    ],
    clock,
    allow
  )
  expect(() => staged(f.store)).toThrow(
    expect.objectContaining({
      code: 'unavailable',
      message: 'Private publication blob is unavailable'
    })
  )
  expect(() => f.reopen().load(prepared.fence.state.publicationId, clock, allow)).toThrow(
    expect.objectContaining({
      code: 'unavailable',
      message: 'Private publication retained records are unavailable'
    })
  )
  expect(f.rows()).toHaveLength(1)
})
it('rejects an individually valid retained pair stored under a different publication address', () => {
  const f = fixture()
  const prepared = createPrivatePublicationRecords(
    request(),
    f.owner.identity,
    { ...selected(), chain: config().identity.chain },
    '10',
    '20'
  )
  const wrongId = 'aa'.repeat(32),
    address = privatePublicationFenceAddress(f.owner.identity, wrongId)
  f.owner.ledger.commit(
    '0',
    [
      {
        ...address,
        expectedRevision: null,
        reservedBytes: 131072,
        reservedUpdates: 5,
        value: protectedValue(prepared.fence, 131072).value
      },
      {
        kind: 'publication',
        key: prepared.fence.state.blobKey,
        expectedRevision: null,
        reservedBytes: 4096,
        reservedUpdates: 0,
        value: protectedValue(prepared.blob, 4096).value
      }
    ],
    clock,
    allow
  )
  expect(() => f.reopen().load(wrongId, clock, allow)).toThrow(
    expect.objectContaining({
      code: 'unavailable',
      message: 'Private publication address binding differs'
    })
  )
  expect(f.rows()).toHaveLength(2)
})
it('consumes each promised update once and retains two slots through readiness loss and restoration', () => {
  const f = fixture(),
    state = staged(f.store)
  const updates = () => f.reopen().load(state.publicationId, clock, allow)!.record.reservedUpdates
  expect(updates()).toBe(5)
  f.store.advance(state.publicationId, '1', { kind: 'reserve-admission' }, clock, allow)
  expect(updates()).toBe(4)
  f.store.advance(
    state.publicationId,
    '2',
    { kind: 'admitted', admission: admission(state) },
    clock,
    allow
  )
  expect(updates()).toBe(3)
  f.store.advance(
    state.publicationId,
    '3',
    { kind: 'bound', binding: binding(state) },
    clock,
    allow
  )
  expect(updates()).toBe(2)
  f.store.advance(
    state.publicationId,
    '4',
    { kind: 'unavailable', reason: 'lookup offline' },
    clock,
    allow
  )
  expect(updates()).toBe(2)
  f.store.advance(
    state.publicationId,
    '5',
    { kind: 'restored', binding: binding(state) },
    clock,
    allow
  )
  expect(updates()).toBe(2)
})
it.each(['rejected', 'expired'] as const)(
  'preserves remaining promised capacity after %s without new reservations',
  kind => {
    const f = fixture(),
      state = staged(f.store)
    const event =
      kind === 'rejected'
        ? { kind, reason: 'invalid publication', noEffect: true as const }
        : { kind, reason: 'staging elapsed' }
    f.store.advance(state.publicationId, '1', event, () => '20', allow)
    const loaded = f.reopen().load(state.publicationId, clock, allow)!
    expect(loaded.record.reservedUpdates).toBe(4)
    expect(loaded.fence.state.progress.phase).toBe(kind)
  }
)
it('requires a synchronous result at the physical stage gate and rolls back both records', () => {
  const f = fixture()
  let gates = 0
  expect(() =>
    f.store.stage(request(), selected(), '20', clock, () => (++gates === 2 ? true : undefined))
  ).toThrow(
    expect.objectContaining({
      code: 'invalid',
      message: 'Private publication guard must be synchronous'
    })
  )
  expect(gates).toBe(2)
  expect(f.rows()).toHaveLength(0)
})
it('requires a synchronous result at the physical advance gate and preserves the reserved phase', () => {
  const f = fixture(),
    state = staged(f.store)
  let gates = 0
  expect(() =>
    f.store.advance(state.publicationId, '1', { kind: 'reserve-admission' }, clock, () =>
      ++gates === 3 ? true : undefined
    )
  ).toThrow(
    expect.objectContaining({
      code: 'invalid',
      message: 'Private publication guard must be synchronous'
    })
  )
  expect(gates).toBe(3)
  expect(f.reopen().load(state.publicationId, clock, allow)!.record.revision).toBe('1')
})
