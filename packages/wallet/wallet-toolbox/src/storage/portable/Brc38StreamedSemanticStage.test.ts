import { Brc38StreamedSemanticStage, type Brc38StreamedStageStore } from './Brc38StreamedSemanticStage'
import { brc38StageTables, type Brc38StageTable } from './Brc38SemanticStage'
import { memoryStageStore, semanticStageFixture, options } from './Brc38SemanticStageFixture'
import type { Brc38JsonStreamedRow } from './Brc38JsonBinaryFields'
import type { Brc38PrivateStructuredPolicy } from './Brc38PrivateStructuredPolicy'

/** A small bridge oracle only; this never establishes actual native ownership,
 * SQL source admission, private quota enforcement or import qualification. */
function fixture() {
  const original = memoryStageStore(),
    data = semanticStageFixture(),
    descriptors = new Map<string, Brc38JsonStreamedRow>(),
    validations: Array<{ table: Brc38StageTable; index: number; policy: Brc38PrivateStructuredPolicy }> = []
  let rejectCurrent = false
  const store: Brc38StreamedStageStore = {
    ...original.store,
    async appendStreamed(record, binaries, structured) {
      await original.store.append(record)
      descriptors.set(JSON.stringify([record.table, record.index]), { fields: record.row, binaries, structured })
    },
    async streamedRow(table, index) {
      return descriptors.get(JSON.stringify([table, index]))
    },
    sealStreamed: original.store.seal,
    async validateStructuredFields(table, index, _fields, selected) {
      if (rejectCurrent) throw new Error('actual current source no longer admits these fields')
      validations.push({ table, index, policy: { ...selected } })
    }
  }
  const policy: Brc38PrivateStructuredPolicy = {
    privateIndexParent: '/private/index-parent',
    maximumTemporaryIndexBytes: 1048576,
    maximumIndexMembers: 10000,
    maximumStructuredBytes: 1000000,
    maximumCanonicalBytes: 1000000
  }
  function row(table: Brc38StageTable): Brc38JsonStreamedRow {
    const fields = { ...data.tables[table][0] },
      structured: Record<string, NonNullable<Brc38JsonStreamedRow['structured']>[string]> = {}
    const names = table === 'provenTxReqs' ? ['history', 'notify'] : table === 'syncStates' ? ['syncMap'] : []
    for (const field of names) {
      delete fields[field]
      structured[field] = { field, encoding: 'utf8-json', bytes: 2, sha256: 'a'.repeat(64) }
    }
    return { fields, binaries: {}, ...(names.length === 0 ? {} : { structured }) }
  }
  return {
    original,
    data,
    store,
    policy,
    validations,
    row,
    reject: () => {
      rejectCurrent = true
    }
  }
}
test('structured bridge retains original all-thirteen-table relations and rechecks fields at closure', async () => {
  const f = fixture(),
    stage = new Brc38StreamedSemanticStage(f.store, options, f.policy)
  for (const table of brc38StageTables) await stage.provisionalRow(table, 0, f.row(table))
  expect(f.validations).toHaveLength(2)
  await stage.validateCompleted(
    f.data,
    Object.fromEntries(brc38StageTables.map(table => [table, 1])) as Record<Brc38StageTable, number>
  )
  expect(f.validations).toHaveLength(4)
  expect(f.original.sealed).toBe(1)
  const stored = await f.store.streamedRow('provenTxReqs', 0)
  expect(stored?.fields).not.toHaveProperty('history')
  expect(stored?.structured?.history).toEqual({
    field: 'history',
    encoding: 'utf8-json',
    bytes: 2,
    sha256: 'a'.repeat(64)
  })
})
test('an earlier structured validation cannot admit a changed source during relationship closure', async () => {
  const f = fixture(),
    stage = new Brc38StreamedSemanticStage(f.store, options, f.policy)
  for (const table of brc38StageTables) await stage.provisionalRow(table, 0, f.row(table))
  f.reject()
  await expect(
    stage.validateCompleted(
      f.data,
      Object.fromEntries(brc38StageTables.map(table => [table, 1])) as Record<Brc38StageTable, number>
    )
  ).rejects.toThrow('actual current source')
  expect(f.original.sealed).toBe(0)
})
test('missing explicit indexed source policy rejects before appending a partial metadata row', async () => {
  const f = fixture(),
    stage = new Brc38StreamedSemanticStage(f.store, options)
  await expect(stage.provisionalRow('provenTxReqs', 0, f.row('provenTxReqs'))).rejects.toThrow('explicit policy')
  expect(await f.store.count('provenTxReqs')).toBe(0)
})
test('structured descriptor aliases are copied before awaiting actual source validation', async () => {
  const f = fixture(),
    input = f.row('provenTxReqs')
  let release!: () => void
  const blocked = new Promise<void>(resolve => {
    release = resolve
  })
  f.store.validateStructuredFields = async () => {
    await blocked
  }
  const stage = new Brc38StreamedSemanticStage(f.store, options, f.policy),
    pending = stage.provisionalRow('provenTxReqs', 0, input)
  Object.assign(input.structured!, {
    history: { field: 'history', encoding: 'utf8-json', bytes: 3, sha256: 'b'.repeat(64) }
  })
  Object.assign(f.policy, { maximumStructuredBytes: 2 })
  release()
  await pending
  expect((await f.store.streamedRow('provenTxReqs', 0))?.structured?.history.bytes).toBe(2)
})
