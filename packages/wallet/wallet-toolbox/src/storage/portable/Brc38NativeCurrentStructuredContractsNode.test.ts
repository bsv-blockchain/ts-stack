import { compareBrc38PrivateDerivedText } from './Brc38PrivateDerivedTextComparisonNode'

import {
  withBrc38PrivateCurrentStructuredSource,
  withBrc38PrivateCurrentStructuredActor
} from './Brc38PrivateCurrentStructuredSourceNode'
import {
  readBrc38NativePackedTextDescriptorData,
  readBrc38NativePackedTextExtentData,
  readBrc38NativePackedTextVersionDescriptorData,
  readBrc38NativePackedTextVersionExtentData
} from './Brc38NativePackedTextFieldsNode'
import { createHash } from 'node:crypto'
import type { Knex } from 'knex'

import { runInSeries } from '../../utility/runInSeries'

import {
  withBrc38NativePrivateContractFixture,
  type Brc38NativePrivateContractFixture
} from './Brc38NativePrivateContractFixture'
import {
  verifyPrivateCurrentStructuredSources,
  verifyPrivateCurrentCheckpointDelta,
  verifyPrivateCurrentLegacySpelling
} from './Brc38PrivateCurrentStructuredSourceNode.case'
import { Brc38WorkingAllocation } from './Brc38WorkingAllocation'

// Independently authored map closure; no production createSyncMap result or
// projection output supplies the expected postimage.
const entities = [
  'provenTx',
  'outputBasket',
  'transaction',
  'provenTxReq',
  'txLabel',
  'txLabelMap',
  'output',
  'outputTag',
  'outputTagMap',
  'certificate',
  'certificateField',
  'commission'
]
function independentMap() {
  return Object.fromEntries(entities.map(entity => [entity, { entityName: entity, count: 0, idMap: {} }]))
}
function policy(fixture: Brc38NativePrivateContractFixture, workingAllocation: Brc38WorkingAllocation) {
  return {
    privateIndexParent: fixture.privateIndexParent,
    expiresAt: fixture.expiresAt,
    maximumTemporaryIndexBytes: 2097152,
    maximumCombinedTemporaryBytes: 4194304,
    maximumIndexMembers: 10000,
    maximumStructuredBytes: 1048576,
    maximumCanonicalBytes: 1048576,
    maximumReadBytes: 1024,
    maximumIndexAllocationBytes: 262144,
    maximumGrammarAllocationBytes: 262144,
    workingAllocation
  }
}
async function seed(fixture: Brc38NativePrivateContractFixture, selectedHistory?: string) {
  const when = new Date('2026-10-08T00:00:00.000Z'),
    history =
      selectedHistory ??
      '{"notes":[{"when":"2026-10-08T00:00:00.000Z","what":"independent 雪😀 history"}],"unknown":null}',
    notify = '{"transactionIds":[17,19],"unknown":"independent 雪"}',
    syncMap = JSON.stringify({ ...independentMap(), unknown: { retained: '雪😀', empty: null } }),
    errorLocal = '{"code":"independent local","description":"雪😀"}',
    errorOther = '{"code":"independent remote","description":"\\u0000"}'
  const coordinates = await fixture.withWriter(async trx => {
    const userId = await fixture.storage.insertUser(
      {
        userId: 0,
        created_at: when,
        updated_at: when,
        identityKey: 'independent structured user',
        activeStorage: 'synthetic target'
      },
      trx
    )
    const requestId = await fixture.storage.insertProvenTxReq(
      {
        provenTxReqId: 0,
        created_at: when,
        updated_at: when,
        status: 'unprocessed',
        attempts: 0,
        notified: false,
        txid: '7'.repeat(64),
        history,
        notify,
        rawTx: []
      },
      trx
    )
    const syncStateId = await fixture.storage.insertSyncState(
      {
        syncStateId: 0,
        userId,
        created_at: when,
        updated_at: when,
        storageIdentityKey: 'independent remote storage',
        storageName: 'independent remote',
        status: 'unknown',
        init: false,
        refNum: 'independent checkpoint',
        syncMap,
        errorLocal,
        errorOther
      },
      trx
    )
    return { requestId, syncStateId }
  })
  return { ...coordinates, history, notify, syncMap, errorLocal, errorOther }
}

test('five current private native JSON fields preserve independent bytes and reject escaped sources', async () => {
  await withBrc38NativePrivateContractFixture(async fixture => {
    const original = await seed(fixture),
      working = new Brc38WorkingAllocation(8388608)
    await fixture.withRead(
      async trx =>
        await verifyPrivateCurrentStructuredSources(
          fixture.storage,
          trx,
          [
            { table: 'provenTxReqs', field: 'history', rowId: original.requestId, expected: original.history },
            { table: 'provenTxReqs', field: 'notify', rowId: original.requestId, expected: original.notify },
            { table: 'syncStates', field: 'syncMap', rowId: original.syncStateId, expected: original.syncMap },
            { table: 'syncStates', field: 'errorLocal', rowId: original.syncStateId, expected: original.errorLocal },
            { table: 'syncStates', field: 'errorOther', rowId: original.syncStateId, expected: original.errorOther }
          ],
          policy(fixture, working)
        )
    )
    expect(working.used).toBe(0)
  })
}, 30000)

test('private checkpoint delta preserves the complete map, unknown members and actual prior bytes', async () => {
  await withBrc38NativePrivateContractFixture(async fixture => {
    const original = await seed(fixture),
      working = new Brc38WorkingAllocation(8388608),
      expected = JSON.stringify({
        ...independentMap(),
        output: { entityName: 'output', count: 1, idMap: { '23': 29 }, maxUpdated_at: '2026-10-08T00:00:01.000Z' },
        unknown: { retained: '雪😀', empty: null }
      })
    await fixture.withRead(
      async trx =>
        await verifyPrivateCurrentCheckpointDelta(
          fixture.storage,
          trx,
          original.syncStateId,
          original.syncMap,
          expected,
          {
            entity: 'output',
            count: 1,
            mappings: [{ incomingId: 23, localId: 29 }],
            maximumUpdatedAt: new Date('2026-10-08T00:00:01.000Z'),
            done: false
          },
          policy(fixture, working)
        )
    )
    expect(working.used).toBe(0)
  })
}, 180000)

test('private legacy spelling drains two real indexes between complete passes', async () => {
  await withBrc38NativePrivateContractFixture(async fixture => {
    const original = await seed(fixture),
      working = new Brc38WorkingAllocation(8388608)
    await fixture.withRead(
      async trx =>
        await verifyPrivateCurrentLegacySpelling(
          fixture.storage,
          trx,
          { table: 'provenTxReqs', field: 'history', rowId: original.requestId, expected: original.history },
          policy(fixture, working)
        )
    )
    expect(working.used).toBe(0)
  })
}, 180000)

test('private current range checks its complete schema at both operation boundaries', async () => {
  await withBrc38NativePrivateContractFixture(async fixture => {
    const original = await seed(fixture),
      working = new Brc38WorkingAllocation(8388608),
      coordinate = { table: 'provenTxReqs', field: 'history', rowId: original.requestId } as const,
      expected = Buffer.from(original.history),
      sha256 = createHash('sha256').update(expected).digest('hex'),
      extent = { ...coordinate, offset: 0, length: expected.length, totalBytes: expected.length },
      versionExtent = { sha256, offset: 0, length: expected.length, totalBytes: expected.length }
    let escaped: Knex.Transaction | undefined
    await fixture.withRead(async trx => {
      escaped = trx
      await withBrc38PrivateCurrentStructuredSource(
        fixture.storage,
        trx,
        coordinate,
        policy(fixture, working),
        async source => {
          let completeSchemaAnchors = 0
          const count = (query: { sql: string; bindings?: readonly unknown[] }): void => {
            if (
              /^select sql from sqlite_schema where name = \? and type = \? limit \?$/.test(
                query.sql.replace(/[`"]/g, '')
              ) &&
              query.bindings?.[0] === 'brc38_native_text_versions' &&
              query.bindings?.[1] === 'table'
            )
              completeSchemaAnchors++
          }
          trx.on('query', count)
          let bytes: Uint8Array | undefined
          try {
            bytes = await source.read(0, expected.length)
            expect(Buffer.from(bytes)).toEqual(expected)
            // Actual schema selection runs before and after every operation.
            // Nested descriptor/extent reads use this same readonly transaction.
            expect(completeSchemaAnchors).toBe(2)
          } finally {
            trx.off('query', count)
            bytes?.fill(0)
          }
        }
      )
      const descriptor = await readBrc38NativePackedTextDescriptorData(trx, coordinate)
      expect(descriptor).toEqual({ bytes: expected.length, sha256 })
      expect(await readBrc38NativePackedTextVersionDescriptorData(trx, sha256)).toEqual(descriptor)
      const rowBytes = await readBrc38NativePackedTextExtentData(trx, extent)
      try {
        expect(Buffer.from(rowBytes)).toEqual(expected)
      } finally {
        rowBytes.fill(0)
      }
      const versionBytes = await readBrc38NativePackedTextVersionExtentData(trx, versionExtent)
      try {
        expect(Buffer.from(versionBytes)).toEqual(expected)
      } finally {
        versionBytes.fill(0)
      }
      const forgedSql = jest.fn(() => {
          throw new Error('Forged SQL executed')
        }),
        forged = Object.assign(forgedSql, { isTransaction: true }) as unknown as Knex.Transaction
      await runInSeries([new Proxy(trx, {}), forged], async copy => {
        await expect(readBrc38NativePackedTextDescriptorData(copy, coordinate)).rejects.toThrow()
        await expect(readBrc38NativePackedTextVersionDescriptorData(copy, sha256)).rejects.toThrow()
        await expect(readBrc38NativePackedTextExtentData(copy, extent)).rejects.toThrow()
        await expect(readBrc38NativePackedTextVersionExtentData(copy, versionExtent)).rejects.toThrow()
      })
      expect(forgedSql).not.toHaveBeenCalled()
    })
    await fixture.withWriter(async trx => {
      await expect(readBrc38NativePackedTextDescriptorData(trx, coordinate)).rejects.toThrow('private readonly')
      await expect(readBrc38NativePackedTextExtentData(trx, extent)).rejects.toThrow('private readonly')
      await expect(readBrc38NativePackedTextVersionDescriptorData(trx, sha256)).rejects.toThrow('private readonly')
      await expect(readBrc38NativePackedTextVersionExtentData(trx, versionExtent)).rejects.toThrow('private readonly')
    })
    expect(escaped).toBeDefined()
    await expect(readBrc38NativePackedTextDescriptorData(escaped!, coordinate)).rejects.toThrow()
    await expect(readBrc38NativePackedTextExtentData(escaped!, extent)).rejects.toThrow()
    expect(working.used).toBe(0)
    expected.fill(0)
  })
}, 180000)

test('private version comparison admits each bounded native read view at its two boundaries', async () => {
  await withBrc38NativePrivateContractFixture(async fixture => {
    const history = JSON.stringify({
        notes: [{ when: '2026-10-08T00:00:00.000Z', what: 'x'.repeat(40000) + '雪😀' }],
        unknown: null
      }),
      original = await seed(fixture, history),
      bytes = Buffer.from(history),
      descriptor = Object.freeze({ bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') }),
      working = new Brc38WorkingAllocation(8388608),
      policy = { expiresAt: fixture.expiresAt, workingAllocation: working },
      budget = { maximum: 16777216, remaining: 16777216 }
    expect(original.history).toBe(history)
    let completeSchemaAnchors = 0
    const count = (query: { sql: string; bindings?: readonly unknown[] }): void => {
        if (
          /^select sql from sqlite_schema where name = \? and type = \? limit \?$/.test(
            query.sql.replace(/[`"]/g, '')
          ) &&
          query.bindings?.[0] === 'brc38_native_text_versions' &&
          query.bindings?.[1] === 'table'
        )
          completeSchemaAnchors++
      },
      borrow = fixture.store.withPrivateNativeDatabase.bind(fixture.store),
      observe = <T>(readOnly: boolean, work: (database: Knex) => Promise<T>): Promise<T> =>
        borrow(readOnly, async database => {
          // Observe the actual borrowed database. The original issuer still
          // creates, enrolls and drains its physical readonly lease.
          if (readOnly) database.on('query', count)
          try {
            return await work(database)
          } finally {
            if (readOnly) database.off('query', count)
          }
        }),
      observed = jest.spyOn(fixture.store, 'withPrivateNativeDatabase').mockImplementation(observe)
    try {
      expect(await compareBrc38PrivateDerivedText(fixture.store, descriptor, descriptor, policy, budget)).toBe(true)
      // Both stored versions are read and independently hashed to EOF, even
      // when their descriptor hashes match. Each view is at most 16 KiB.
      expect(completeSchemaAnchors).toBe(2 * Math.ceil(bytes.length / 16384))
    } finally {
      observed.mockRestore()
      bytes.fill(0)
    }
    expect(working.used).toBe(0)
  })
}, 90000)

test('private current index source-change cannot escape the final complete source boundary', async () => {
  await withBrc38NativePrivateContractFixture(async fixture => {
    const history = '{"notes":[]}',
      changed = '{"notes":[],"changed":true}',
      original = await seed(fixture, history),
      working = new Brc38WorkingAllocation(8388608)
    let escapedResult: unknown
    await expect(
      withBrc38PrivateCurrentStructuredActor(
        fixture.store,
        fixture.storage,
        { table: 'provenTxReqs', field: 'history', rowId: original.requestId },
        policy(fixture, working),
        async source => {
          const index = await source.openIndex()
          try {
            await fixture.withWriter(async trx => {
              expect(await fixture.storage.updateProvenTxReq(original.requestId, { history: changed }, trx)).toBe(1)
              const rows = await fixture.storage.findProvenTxReqs({
                partial: { provenTxReqId: original.requestId },
                trx
              })
              expect(rows).toHaveLength(1)
              expect(rows[0].history).toBe(changed)
            })
            await index.put(0, { key: 'notes', keyOffset: 1, start: 9, end: 11 })
            return 'provisional callback result'
          } finally {
            await index.close()
          }
        }
      ).then(value => {
        escapedResult = value
        return value
      })
    ).rejects.toThrow('Private current structured source differs')
    expect(escapedResult).toBeUndefined()
    expect(working.used).toBe(0)
  })
}, 90000)

test('private current index cancellation preserves its actual cause and drains physical work', async () => {
  await withBrc38NativePrivateContractFixture(async fixture => {
    const original = await seed(fixture, '{"notes":[]}'),
      working = new Brc38WorkingAllocation(8388608),
      controller = new AbortController(),
      reason = new Error('Independent current-index cancellation')
    await expect(
      withBrc38PrivateCurrentStructuredActor(
        fixture.store,
        fixture.storage,
        { table: 'provenTxReqs', field: 'history', rowId: original.requestId },
        { ...policy(fixture, working), signal: controller.signal },
        async source => {
          const index = await source.openIndex()
          try {
            controller.abort(reason)
            await expect(index.put(0, { key: 'notes', keyOffset: 1, start: 9, end: 11 })).rejects.toBe(reason)
          } finally {
            await index.close()
          }
        }
      )
    ).rejects.toBe(reason)
    expect(working.used).toBe(0)
  })
}, 90000)

test('private current derived index work owns filesystem checks without repeated native schema traversal', async () => {
  await withBrc38NativePrivateContractFixture(async fixture => {
    const history = '{"notes":[]}',
      original = await seed(fixture, history),
      working = new Brc38WorkingAllocation(8388608)
    await fixture.withRead(async trx => {
      await withBrc38PrivateCurrentStructuredSource(
        fixture.storage,
        trx,
        { table: 'provenTxReqs', field: 'history', rowId: original.requestId },
        policy(fixture, working),
        async source => {
          const bytes = await source.read(0, Buffer.byteLength(history))
          try {
            expect(Buffer.from(bytes).toString('utf8')).toBe(history)
          } finally {
            bytes.fill(0)
          }
          const index = await source.openIndex()
          let nativeQueries = 0,
            completeSchemaAnchors = 0
          const count = (query: { sql: string; bindings?: readonly unknown[] }): void => {
            nativeQueries++
            if (
              /^select sql from sqlite_schema where name = \? and type = \? limit \?$/.test(
                query.sql.replace(/[`"]/g, '')
              ) &&
              query.bindings?.[0] === 'brc38_native_text_versions' &&
              query.bindings?.[1] === 'table'
            )
              completeSchemaAnchors++
          }
          trx.on('query', count)
          try {
            const member = { key: 'notes', keyOffset: 1, start: 9, end: 11 }
            await index.put(0, member)
            await index.seal()
            expect(await index.lookup!(0, 'notes')).toEqual({ ...member, firstKeyOffset: 1 })
            const actual = []
            for await (const value of index.entries(0)) actual.push(value)
            expect(actual).toEqual([member])
            console.info(
              JSON.stringify({
                diagnosticOnly: true,
                event: 'private-index-native-query-boundaries',
                nativeQueries,
                completeSchemaAnchors,
                independentMemberPassed: true
              })
            )
            expect(completeSchemaAnchors).toBe(0)
            expect(nativeQueries).toBe(0)
          } finally {
            trx.off('query', count)
            await index.close()
          }
        }
      )
    })
    expect(working.used).toBe(0)
  })
}, 90000)
