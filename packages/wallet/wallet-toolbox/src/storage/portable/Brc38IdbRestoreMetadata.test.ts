import { brc38ImportTableOrder, brc38ImportRowForm } from './Brc38ImportForms'
import { prepareBrc38IdbRestoreMetadata, type Brc38IdbRestoreParent } from './Brc38IdbRestoreMetadata'
import { decodePortableRow } from './Brc38PortableRows'
import { semanticStageFixture } from './Brc38SemanticStageFixture'

// Authored UNRUN. Pure DATA preparation cases do not claim a genuine source,
// provider, authentication, effect, activation or browser qualification.
test('all thirteen original row families use their IDB store and remap the exact parent fields', () => {
  const f = semanticStageFixture(),
    expectedStores = [
      'proven_txs',
      'output_baskets',
      'output_tags',
      'tx_labels',
      'transactions',
      'outputs',
      'tx_labels_map',
      'output_tags_map',
      'certificates',
      'certificate_fields',
      'commissions',
      'proven_tx_reqs',
      'sync_states'
    ],
    sourceJson = JSON.stringify(f)
  for (const [position, table] of brc38ImportTableOrder.entries()) {
    const form = brc38ImportRowForm(table),
      original = decodePortableRow<Record<string, unknown>>(form.kind, f.tables[table][0]),
      parents: Brc38IdbRestoreParent[] = []
    for (const parent of form.parents) {
      const id = original[parent.field]
      if (id !== undefined && !parents.some(value => value.entity === parent.entity && value.incomingId === id))
        parents.push({ entity: parent.entity, incomingId: id as number, localId: 1000 + parents.length })
    }
    const field = table === 'provenTxReqs' ? 'notify' : table === 'syncStates' ? 'syncMap' : undefined,
      prepared = prepareBrc38IdbRestoreMetadata(
        table,
        original,
        71,
        parents,
        { maximum: 1048576, remaining: 1048576 },
        field === undefined
          ? undefined
          : { field, originalJson: original[field] as string, mappedJson: '{}', activated: false, unmappedIds: 0 }
      )
    expect(prepared.store).toBe(expectedStores[position])
    if (Object.hasOwn(original, 'userId')) expect(prepared.row.userId).toBe(71)
    for (const parent of form.parents)
      if (original[parent.field] !== undefined)
        expect(prepared.row[parent.field]).toBe(
          parents.find(value => value.entity === parent.entity && value.incomingId === original[parent.field])!.localId
        )
    if (form.id !== undefined) {
      expect(prepared.identity).toEqual({ entity: form.entity, incomingId: original[form.id] })
      expect(prepared.row).not.toHaveProperty(form.id)
    }
    if (table === 'syncStates') {
      expect(prepared.originalSyncStateId).toBe(original.syncStateId)
      expect(prepared.row).not.toHaveProperty('syncStateId')
      expect(prepared.row.init).toBe(false)
    }
  }
  expect(JSON.stringify(f)).toBe(sourceJson)
})
test.each([0, -1, 1e100])('incoming integer %s retains identity independently of the generated key', provenTxId => {
  const prepared = prepareBrc38IdbRestoreMetadata(
    'provenTxs',
    { provenTxId, rawTx: [1, 2], created_at: new Date('2026-01-01'), updated_at: new Date('2026-01-01') },
    1,
    [],
    { maximum: 65536, remaining: 65536 }
  )
  expect(prepared.identity).toEqual({ entity: 'provenTx', incomingId: provenTxId })
  expect(prepared.row).not.toHaveProperty('provenTxId')
  expect(prepared.row.rawTx).toEqual([1, 2])
})
test('missing/extra/conflicting parent and activated/stale history data refuse before an effect', () => {
  const budget = () => ({ maximum: 65536, remaining: 65536 }),
    row = { outputId: 0, transactionId: -1, userId: 0 }
  expect(() => prepareBrc38IdbRestoreMetadata('outputs', row, 1, [], budget())).toThrow()
  expect(() =>
    prepareBrc38IdbRestoreMetadata(
      'outputs',
      row,
      1,
      [
        { entity: 'transaction', incomingId: -1, localId: 2 },
        { entity: 'outputBasket', incomingId: 1, localId: 3 }
      ],
      budget()
    )
  ).toThrow()
  expect(() =>
    prepareBrc38IdbRestoreMetadata(
      'outputs',
      row,
      1,
      [
        { entity: 'transaction', incomingId: -1, localId: 2 },
        { entity: 'transaction', incomingId: -1, localId: 3 }
      ],
      budget()
    )
  ).toThrow()
  expect(() =>
    prepareBrc38IdbRestoreMetadata('syncStates', { syncStateId: -1, syncMap: '{}' }, 1, [], budget(), {
      field: 'syncMap',
      originalJson: '{"changed":true}',
      mappedJson: '{}',
      activated: false,
      unmappedIds: 0
    })
  ).toThrow()
  expect(() =>
    prepareBrc38IdbRestoreMetadata(
      'provenTxs',
      { provenTxId: 1, rawTx: Array.from({ length: 1000 }, () => 1) },
      1,
      [],
      {
        maximum: 1024,
        remaining: 1024
      }
    )
  ).toThrow('allocation budget')
})
test('portable form definitions cannot be changed by a caller', () => {
  const form = brc38ImportRowForm('outputs')
  expect(Object.isFrozen(form)).toBe(true)
  expect(Object.isFrozen(form.parents)).toBe(true)
  for (const parent of form.parents) expect(Object.isFrozen(parent)).toBe(true)
})
