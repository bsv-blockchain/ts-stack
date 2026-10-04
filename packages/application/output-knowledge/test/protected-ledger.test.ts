import { expect, it } from '@jest/globals'
import { createSecretKey } from 'node:crypto'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { spawnSync, spawn } from 'node:child_process'
import { canonicalOutputJSON } from '@bsv/sdk'
import { SQLiteProtectedLedger } from '../src/private/SQLiteProtectedLedger.js'
import { NodeProtectedPayloadCodec } from '../src/private/NodeProtectedPayloadCodec.js'
import { protectedRevisionCapacity, protectedDigest } from '../src/private/ProtectedLedgerCodec.js'

import {
  fixture,
  configuration,
  clock,
  authorize,
  address,
  change,
  codec,
  key
} from './protected-ledger-fixture.js'

it('atomically commits protected records and returns owned values across reopen', () => {
  const f = fixture()
  const input = change()
  expect(
    f.ledger.commit('0', [input, { ...change(2), kind: 'request-fence' }], clock, authorize)
  ).toBe('1')
  input.value.secret = 'caller-mutation'
  const first = f.ledger.read([address()], clock, authorize)
  expect(first).toMatchObject({
    revision: '1',
    observedAt: '100',
    records: [{ revision: '1', reservedBytes: 128, value: { secret: 'synthetic-material' } }]
  })
  first.records[0]!.value.secret = 'returned-mutation'
  expect(f.reopen().read([address()], () => '99', authorize).records[0]!.value.secret).toBe(
    'synthetic-material'
  )
  const db = new DatabaseSync(f.path)
  try {
    const rows = db.prepare('SELECT * FROM protected_records').all()
    expect(JSON.stringify(rows)).not.toContain('synthetic-material')
    expect(JSON.stringify(rows)).not.toContain('caller-mutation')
  } finally {
    db.close()
  }
})

it('never creates state during open or adopts a different store/configuration identity', () => {
  const f = fixture()
  expect(() => SQLiteProtectedLedger.create(f.path, configuration, codec())).toThrow()
  expect(() =>
    SQLiteProtectedLedger.open(join(f.directory, 'absent.db'), configuration, codec())
  ).toThrow()
  expect(() =>
    SQLiteProtectedLedger.open(f.path, { ...configuration, storeId: 'cd'.repeat(32) }, codec())
  ).toThrow()
  expect(() =>
    SQLiteProtectedLedger.open(
      f.path,
      { ...configuration, binding: { service: 'another' } },
      codec()
    )
  ).toThrow()
  expect(() =>
    SQLiteProtectedLedger.open(f.path, { ...configuration, maximumRecords: 15 }, codec())
  ).toThrow()
})

it('checks both the current head and each record version, preserving clock observations on rejection', () => {
  const f = fixture()
  f.ledger.commit('0', [change()], clock, authorize)
  expect(() => f.ledger.commit('0', [change(2)], () => '120', authorize)).toThrow(
    'changed before commit'
  )
  expect(() =>
    f.ledger.commit('1', [{ ...change(), expectedRevision: '9' }], () => '130', authorize)
  ).toThrow('record changed')
  const result = f.reopen().read([address(2)], () => '50', authorize)
  expect(result).toEqual({ revision: '1', observedAt: '130', records: [undefined] })
})

it('rolls back every earlier record when a later capacity or reservation check fails', () => {
  const f = fixture({ ...configuration, maximumRecords: 2, maximumReservedBytes: 256 })
  expect(() =>
    f.ledger.commit('0', [change(1), change(2), change(3)], () => '110', authorize)
  ).toThrow('capacity is full')
  expect(f.reopen().read([address(1), address(2)], clock, authorize)).toEqual({
    revision: '0',
    observedAt: '110',
    records: [undefined, undefined]
  })
  f.ledger.commit('0', [change(1), change(2)], clock, authorize)
  expect(() =>
    f.ledger.commit(
      '1',
      [{ ...change(1, { secret: 'x' }, 64), expectedRevision: '1' }],
      clock,
      authorize
    )
  ).toThrow('reservation')
  expect(() =>
    f.ledger.commit(
      '1',
      [{ ...change(1, { secret: 'x'.repeat(200) }, 128), expectedRevision: '1' }],
      clock,
      authorize
    )
  ).toThrow('reservation')
  expect(f.ledger.read([address(1)], clock, authorize).records[0]!.revision).toBe('1')
})

it('rechecks live authorization before private reads and synchronous disclosure', () => {
  const f = fixture()
  f.ledger.commit(
    '0',
    [change(), { ...change(2, { secret: 'allow' }), kind: 'rules' }],
    clock,
    authorize
  )
  let delivered = 0
  const guard = (view: Parameters<Parameters<SQLiteProtectedLedger['read']>[2]>[0]) => {
    if (view.get({ ...address(2), kind: 'rules' })!.value.secret !== 'allow')
      throw new Error('private access unavailable')
  }
  f.ledger.disclose('1', [address()], clock, guard, records => {
    expect(records[0]!.value.secret).toBe('synthetic-material')
    delivered++
  })
  f.reopen().commit(
    '1',
    [{ ...change(2, { secret: 'deny' }), kind: 'rules', expectedRevision: '1' }],
    () => '140',
    authorize
  )
  expect(() =>
    f.ledger.disclose(
      '1',
      [address()],
      () => '150',
      guard,
      () => {
        delivered++
      }
    )
  ).toThrow('private access unavailable')
  expect(() => f.ledger.read([address(99)], clock, guard)).toThrow('private access unavailable')
  expect(delivered).toBe(1)
  expect(f.ledger.read([address()], clock, authorize).observedAt).toBe('150')
})

it('does not repeat an enqueue when the caller reports an uncertain post-enqueue error', () => {
  const f = fixture()
  f.ledger.commit('0', [change()], clock, authorize)
  let attempts = 0
  expect(() =>
    f.ledger.disclose(
      '1',
      [address()],
      () => '120',
      authorize,
      () => {
        attempts++
        throw new Error('reply lost')
      }
    )
  ).toThrow('reply lost')
  expect(attempts).toBe(1)
  expect(f.reopen().read([address()], clock, authorize).observedAt).toBe('120')
})

it('rejects asynchronous and reentrant callbacks before any commit or enqueue', () => {
  const f = fixture()
  expect(() => f.ledger.read([address()], clock, (async () => {}) as () => void)).toThrow(
    'synchronous'
  )
  expect(() =>
    f.ledger.commit('0', [change()], clock, () => {
      f.ledger.read([address()], clock, authorize)
    })
  ).toThrow('reentered')
  expect(() =>
    f.ledger.disclose('0', [address()], clock, authorize, (async () => {}) as () => void)
  ).toThrow('synchronous')
  expect(f.ledger.read([address()], clock, authorize).revision).toBe('0')
})

it('detects missing records and header tampering through authenticated inventory', () => {
  for (const sql of [
    'DELETE FROM protected_records',
    'UPDATE protected_records SET reserved_bytes=reserved_bytes+1',
    "UPDATE protected_records SET revision='2'"
  ]) {
    const f = fixture()
    f.ledger.commit('0', [change()], clock, authorize)
    const db = new DatabaseSync(f.path)
    try {
      db.exec(sql)
    } finally {
      db.close()
    }
    expect(() => f.ledger.read([address()], clock, authorize)).toThrow('inventory')
    expect(() => f.reopen()).toThrow('inventory')
  }
})

it('detects ciphertext tampering and refuses missing custody without creating replacement material', () => {
  const f = fixture()
  f.ledger.commit('0', [change()], clock, authorize)
  expect(() =>
    f.reopen(
      new NodeProtectedPayloadCodec(
        { resolve: () => createSecretKey(Buffer.alloc(32, 20)) },
        'fixture-key'
      )
    )
  ).toThrow('authentication')
  const db = new DatabaseSync(f.path)
  try {
    db.prepare('UPDATE protected_records SET envelope=?').run('{}')
  } finally {
    db.close()
  }
  expect(() => f.ledger.read([address()], clock, authorize)).toThrow('integrity')
  expect(() => f.reopen()).toThrow('integrity')
})

it('requires old custody keys for retained promises while writing with a rotated key', () => {
  const keys = new Map([
    ['old', key],
    ['new', createSecretKey(Buffer.alloc(32, 21))]
  ])
  const provider = {
    resolve: (id: string) => {
      const found = keys.get(id)
      if (!found) throw new Error('missing')
      return found
    }
  }
  const f = fixture(configuration, new NodeProtectedPayloadCodec(provider, 'old'))
  f.ledger.commit('0', [change()], clock, authorize)
  const rotated = f.reopen(new NodeProtectedPayloadCodec(provider, 'new'))
  rotated.commit('1', [change(2)], clock, authorize)
  expect(rotated.read([address(), address(2)], clock, authorize).records).toHaveLength(2)
  keys.delete('old')
  expect(() => f.reopen(new NodeProtectedPayloadCodec(provider, 'new'))).toThrow('custody')
})

it.each(['before-second-record', 'after-commit'])(
  'recovers exact atomic state after actual process loss: %s',
  phase => {
    const f = fixture()
    f.ledger.close()
    const ledgerURL = new URL('../dist/private/SQLiteProtectedLedger.js', import.meta.url).href
    const payloadURL = new URL('../dist/private/NodeProtectedPayloadCodec.js', import.meta.url).href
    const script = `import { createSecretKey } from 'node:crypto'; import { SQLiteProtectedLedger } from ${JSON.stringify(ledgerURL)}; import { NodeProtectedPayloadCodec } from ${JSON.stringify(payloadURL)};
    let armed=false,calls=0; const payload=new NodeProtectedPayloadCodec({ resolve(){ if(armed && ++calls===2 && ${JSON.stringify(phase)}==='before-second-record') process.kill(process.pid,'SIGKILL'); return createSecretKey(Buffer.alloc(32,19)); }},'fixture-key');
    const ledger=SQLiteProtectedLedger.open(${JSON.stringify(f.path)},${JSON.stringify(configuration)},payload); armed=true;
    ledger.commit('0',${JSON.stringify([change(), change(2)])},()=> '100',()=>{}); process.kill(process.pid,'SIGKILL');`
    const child = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
      encoding: 'utf8',
      timeout: 15000
    })
    expect(child.error).toBeUndefined()
    expect(child.signal).toBe('SIGKILL')
    const result = f.reopen().read([address(), address(2)], clock, authorize)
    expect(result.revision).toBe(phase === 'after-commit' ? '1' : '0')
    expect(result.records.filter(Boolean)).toHaveLength(phase === 'after-commit' ? 2 : 0)
  }
)

it('rejects accessor-bearing plans without invoking them and expires guarded readers', () => {
  const f = fixture()
  let calls = 0
  const input = change()
  Object.defineProperty(input, 'value', {
    enumerable: true,
    get() {
      calls++
      return { secret: 'unexpected' }
    }
  })
  expect(() => f.ledger.commit('0', [input], clock, authorize)).toThrow()
  const addresses = [address()]
  Object.defineProperty(addresses, '0', {
    enumerable: true,
    get() {
      calls++
      return address()
    }
  })
  expect(() => f.ledger.read(addresses, clock, authorize)).toThrow()
  expect(calls).toBe(0)
  let reader: Parameters<Parameters<SQLiteProtectedLedger['read']>[2]>[0] | undefined
  f.ledger.read([address()], clock, view => {
    reader = view
  })
  expect(() => reader!.get(address())).toThrow('expired')
  expect(() =>
    f.ledger.read([address()], clock, () => {
      reader!.get(address())
    })
  ).toThrow('expired')
})

it('reserves future revisions without allowing unrelated commits to consume the last completion budget', () => {
  expect(() => protectedRevisionCapacity('18446744073709551613', 2)).not.toThrow()
  expect(() => protectedRevisionCapacity('18446744073709551614', 2)).toThrow('completion revisions')
  expect(() => protectedRevisionCapacity('18446744073709551614', 1)).not.toThrow()
  expect(() => protectedRevisionCapacity('18446744073709551615', 0)).not.toThrow()
  const f = fixture()
  f.ledger.commit('0', [change()], clock, authorize)
  expect(() =>
    f.ledger.commit(
      '1',
      [{ ...change(), expectedRevision: '1', reservedUpdates: 0 }],
      clock,
      authorize
    )
  ).toThrow('completion reservation')
  f.ledger.commit(
    '1',
    [{ ...change(), expectedRevision: '1', reservedUpdates: 3 }],
    clock,
    authorize
  )
  expect(f.reopen().read([address()], clock, authorize).records[0]!.reservedUpdates).toBe(3)
})

it('preserves the last two native completion revisions for the existing obligation', () => {
  const f = fixture(),
    payloads = codec()
  f.ledger.commit('0', [{ ...change(), reservedUpdates: 2 }], clock, authorize)
  const binding = (revision: string) => ({
    format: 'output-protected-ledger/1',
    storeId: configuration.storeId,
    configuration: protectedDigest(canonicalOutputJSON(configuration)),
    kind: 'head',
    revision
  })
  const db = new DatabaseSync(f.path)
  try {
    const row = db.prepare('SELECT envelope FROM protected_head').get()!
    const original = JSON.parse(
      Buffer.from(payloads.open(binding('1'), JSON.parse(String(row.envelope)))).toString('utf8')
    )
    original.revision = '18446744073709551613'
    const envelope = payloads.seal(
      binding(original.revision),
      Buffer.from(canonicalOutputJSON(original))
    )
    db.prepare('UPDATE protected_head SET revision=?,envelope=?').run(
      original.revision,
      canonicalOutputJSON(envelope)
    )
  } finally {
    db.close()
  }
  const owner = f.reopen()
  expect(() =>
    owner.commit('18446744073709551613', [{ ...change(2), reservedUpdates: 0 }], clock, authorize)
  ).toThrow('completion revisions')
  expect(owner.read([address(2)], clock, authorize).records[0]).toBeUndefined()
  expect(
    owner.commit(
      '18446744073709551613',
      [{ ...change(), expectedRevision: '1', reservedUpdates: 1 }],
      clock,
      authorize
    )
  ).toBe('18446744073709551614')
  expect(
    owner.commit(
      '18446744073709551614',
      [{ ...change(), expectedRevision: '2', reservedUpdates: 0 }],
      clock,
      authorize
    )
  ).toBe('18446744073709551615')
  expect(owner.read([address()], clock, authorize).records[0]!.revision).toBe('3')
})

it('serializes independently opened processes competing for one atomic record group', async () => {
  const f = fixture()
  f.ledger.close()
  const ledgerURL = new URL('../dist/private/SQLiteProtectedLedger.js', import.meta.url).href
  const payloadURL = new URL('../dist/private/NodeProtectedPayloadCodec.js', import.meta.url).href
  const children = [1, 3].map(index => {
    const script = `import { createSecretKey } from 'node:crypto'; import { SQLiteProtectedLedger } from ${JSON.stringify(ledgerURL)}; import { NodeProtectedPayloadCodec } from ${JSON.stringify(payloadURL)};
      const payloads=new NodeProtectedPayloadCodec({resolve:()=>createSecretKey(Buffer.alloc(32,19))},'fixture-key');
      const ledger=SQLiteProtectedLedger.open(${JSON.stringify(f.path)},${JSON.stringify(configuration)},payloads);
      console.log('ready'); process.stdin.once('data',()=>{try {ledger.commit('0',${JSON.stringify([change(index), change(index + 1)])},()=> '100',()=>{});console.log('committed');}catch(error){console.log(error.code)}finally{ledger.close();process.stdin.destroy();}});`
    const child = spawn(process.execPath, ['--input-type=module', '-e', script], {
      stdio: ['pipe', 'pipe', 'pipe']
    })
    let text = '',
      errors = ''
    const ready = new Promise<void>((resolve, reject) => {
      child.once('error', reject)
      child.stdout.on('data', data => {
        text += String(data)
        if (text.includes('ready')) resolve()
      })
      child.once('exit', () => {
        if (!text.includes('ready')) reject(new Error('Child did not reach ready'))
      })
    })
    child.stderr.on('data', data => {
      errors += String(data)
    })
    const exited = new Promise<{ code: number | null; text: string; errors: string }>(resolve =>
      child.once('exit', code => resolve({ code, text, errors }))
    )
    return { child, ready, exited }
  })
  const timer = setTimeout(() => {
    for (const { child } of children) child.kill('SIGKILL')
  }, 15000)
  try {
    await Promise.all(children.map(child => child.ready))
    for (const { child } of children) child.stdin.end('start')
    const results = await Promise.all(children.map(child => child.exited))
    expect(results.map(result => result.code)).toEqual([0, 0])
    expect(results.map(result => result.text.trim().split('\n').at(-1)).sort()).toEqual([
      'committed',
      'conflict'
    ])
    const snapshot = f.reopen().read([1, 2, 3, 4].map(address), clock, authorize)
    expect(snapshot.revision).toBe('1')
    expect(snapshot.records.map(Boolean)).toEqual(
      snapshot.records[0] ? [true, true, false, false] : [false, false, true, true]
    )
  } finally {
    clearTimeout(timer)
    for (const { child } of children) child.kill('SIGKILL')
  }
}, 20000)

it('rejects an undersized custody codec before creating a ledger that cannot honor its reservations', () => {
  const f = fixture()
  expect(() =>
    SQLiteProtectedLedger.create(
      join(f.directory, 'small.db'),
      configuration,
      new NodeProtectedPayloadCodec({ resolve: () => key }, 'fixture-key', 512)
    )
  ).toThrow('cannot honor ledger reservations')
})

it.each([
  { maximumRecords: 0 },
  { maximumRecords: 4097 },
  { maximumRecords: 1.5 },
  { maximumReservedBytes: 0 },
  { maximumReservedBytes: 67108865 },
  { maximumRecordBytes: 0 },
  { maximumRecordBytes: 2097153 },
  { storeId: 'not-an-identity' },
  { binding: [] },
  { unexpected: true }
])('rejects invalid immutable installation configuration: %j', invalid => {
  const f = fixture()
  expect(() =>
    SQLiteProtectedLedger.create(
      join(f.directory, 'invalid.db'),
      { ...configuration, ...invalid } as typeof configuration,
      codec()
    )
  ).toThrow()
})

it.each(
  [
    [],
    Array.from({ length: 65 }, (_, index) => change(index + 1)),
    [change(), change()],
    [{ ...change(), kind: 'unknown' }],
    [{ ...change(), key: 'not-a-key' }],
    [{ ...change(), value: null }],
    [{ ...change(), value: [] }],
    [{ ...change(), reservedBytes: 0 }],
    [{ ...change(), reservedBytes: 1025 }],
    [{ ...change(), reservedUpdates: -1 }],
    [{ ...change(), reservedUpdates: 65 }],
    [{ ...change(), expectedRevision: '00' }],
    [{ ...change(), unexpected: true }]
  ].map(changes => ({ changes }))
)('rejects malformed mutation plans without writing a record: %#', ({ changes }) => {
  const f = fixture()
  expect(() =>
    f.ledger.commit(
      '0',
      changes as unknown as Parameters<SQLiteProtectedLedger['commit']>[1],
      clock,
      authorize
    )
  ).toThrow()
  expect(f.ledger.read([address()], clock, authorize).records[0]).toBeUndefined()
})

it('rejects empty or excessive reads, changed disclosure heads, bad clocks and closed owners', () => {
  const f = fixture()
  expect(() => f.ledger.read([], clock, authorize)).toThrow()
  expect(() =>
    f.ledger.read(
      Array.from({ length: 65 }, (_, i) => address(i)),
      clock,
      authorize
    )
  ).toThrow()
  expect(() => f.ledger.read([address()], () => '-1', authorize)).toThrow()
  let calls = 0
  expect(() =>
    f.ledger.disclose('1', [address()], clock, authorize, () => {
      calls++
    })
  ).toThrow('changed before disclosure')
  expect(calls).toBe(0)
  f.ledger.close()
  expect(() => f.ledger.read([address()], clock, authorize)).toThrow('closed')
})

it('rejects Promise-returning synchronous-shaped guards and enqueue functions', () => {
  const f = fixture()
  const promise = () => Promise.resolve()
  expect(() => f.ledger.read([address()], clock, promise as () => void)).toThrow('asynchronous')
  expect(() =>
    f.ledger.disclose('0', [address()], clock, authorize, promise as () => void)
  ).toThrow('synchronous')
  expect(f.ledger.read([address()], clock, authorize).revision).toBe('0')
})

it.each([
  "UPDATE protected_records SET kind=printf('%1000000s','x')",
  "UPDATE protected_records SET key=printf('%1000000s','x')",
  "UPDATE protected_records SET revision=printf('%1000000s','1')",
  "UPDATE protected_records SET sealed_digest=printf('%1000000s','a')",
  "UPDATE protected_records SET envelope=printf('%1000000s','x')",
  "UPDATE protected_head SET revision=printf('%1000000s','1')",
  "UPDATE protected_head SET envelope=printf('%1000000s','x')",
  'DELETE FROM protected_head'
])('fails closed on oversized or absent stored fields: %#', sql => {
  const f = fixture()
  f.ledger.commit('0', [change()], clock, authorize)
  const db = new DatabaseSync(f.path)
  try {
    db.exec(sql)
  } finally {
    db.close()
  }
  expect(() => f.ledger.read([address()], clock, authorize)).toThrow()
  expect(() => f.reopen()).toThrow()
})

it('rolls back all record changes when metadata sealing fails after their writes', () => {
  let armed = false,
    calls = 0
  const payloads = new NodeProtectedPayloadCodec(
    {
      resolve: () => {
        if (armed && ++calls === 2) throw new Error('synthetic custody interruption')
        return key
      }
    },
    'fixture-key'
  )
  const f = fixture(configuration, payloads)
  expect(() =>
    f.ledger.commit(
      '0',
      [change()],
      () => '170',
      () => {
        armed = true
      }
    )
  ).toThrow('custody')
  const result = f.reopen().read([address()], clock, authorize)
  expect(result).toEqual({ revision: '0', observedAt: '170', records: [undefined] })
})

it('avoids redundant physical head writes while checking fresh authority and preserving refusal clocks', () => {
  const f = fixture()
  f.ledger.commit('0', [change()], clock, authorize)
  const db = new DatabaseSync(f.path)
  const envelope = () =>
    String(db.prepare('SELECT envelope FROM protected_head WHERE id=1').get()!.envelope)
  try {
    const original = envelope()
    let checks = 0
    const guard = () => {
      checks++
    }
    expect(f.ledger.read([address()], clock, guard).records[0]!.value.secret).toBe(
      'synthetic-material'
    )
    expect(f.ledger.read([address()], () => '99', guard).observedAt).toBe('100')
    expect(checks).toBe(2)
    expect(envelope()).toBe(original)
    f.reopen().commit(
      '1',
      [{ ...change(1, { secret: 'updated' }), expectedRevision: '1' }],
      clock,
      authorize
    )
    const foreign = envelope()
    expect(foreign).not.toBe(original)
    expect(f.ledger.read([address()], clock, guard).records[0]!.value.secret).toBe('updated')
    expect(checks).toBe(3)
    expect(envelope()).toBe(foreign)
    expect(() =>
      f.ledger.read(
        [address()],
        () => '130',
        () => {
          throw new Error('permission revoked')
        }
      )
    ).toThrow('permission revoked')
    const refused = envelope()
    expect(refused).not.toBe(foreign)
    expect(f.reopen().read([address()], () => '99', authorize)).toMatchObject({
      revision: '2',
      observedAt: '130'
    })
    expect(envelope()).toBe(refused)
  } finally {
    db.close()
  }
})

it('rotates the custody of an unchanged empty head during a pure read', () => {
  const keys = new Map([
    ['old', key],
    ['new', createSecretKey(Buffer.alloc(32, 21))]
  ])
  const provider = {
    resolve(id: string) {
      const found = keys.get(id)
      if (!found) throw new Error('missing')
      return found
    }
  }
  const f = fixture(configuration, new NodeProtectedPayloadCodec(provider, 'old'))
  f.ledger.read([address()], clock, authorize)
  const db = new DatabaseSync(f.path)
  const envelope = () =>
    String(db.prepare('SELECT envelope FROM protected_head WHERE id=1').get()!.envelope)
  try {
    const old = envelope()
    expect(JSON.parse(old).keyId).toBe('old')
    const rotated = f.reopen(new NodeProtectedPayloadCodec(provider, 'new'))
    expect(rotated.read([address()], clock, authorize)).toEqual({
      revision: '0',
      observedAt: '100',
      records: [undefined]
    })
    expect(envelope()).not.toBe(old)
    expect(JSON.parse(envelope()).keyId).toBe('new')
    keys.delete('old')
    expect(
      f.reopen(new NodeProtectedPayloadCodec(provider, 'new')).read([address()], clock, authorize)
        .observedAt
    ).toBe('100')
  } finally {
    db.close()
  }
})

it('still refuses unchanged reads when the active write custody key becomes unavailable', () => {
  const keys = new Map([
    ['old', key],
    ['new', createSecretKey(Buffer.alloc(32, 21))]
  ])
  const provider = {
    resolve(id: string) {
      const found = keys.get(id)
      if (!found) throw new Error('missing')
      return found
    }
  }
  const f = fixture(configuration, new NodeProtectedPayloadCodec(provider, 'old'))
  f.ledger.read([address()], clock, authorize)
  const rotated = f.reopen(new NodeProtectedPayloadCodec(provider, 'new'))
  const db = new DatabaseSync(f.path)
  try {
    const old = db.prepare('SELECT envelope FROM protected_head WHERE id=1').get()!.envelope
    keys.delete('new')
    expect(() => rotated.read([address()], clock, authorize)).toThrow('custody is unavailable')
    expect(db.prepare('SELECT envelope FROM protected_head WHERE id=1').get()!.envelope).toBe(old)
    expect(f.ledger.read([address()], clock, authorize).observedAt).toBe('100')
  } finally {
    db.close()
  }
})
