import type { Knex } from 'knex'
import { fixture, value } from '../../../test/utils/snapshotSqliteFixtures'
import { installGeneration, names, progress, metadata } from '../schema/snapshotSqliteIndexGeneration'
import { copyGenerationPage, valid, type Position } from '../schema/snapshotSqliteIndexBootstrap'
import { readGenerationIndexState, migration } from '../schema/snapshotSqliteIndexState'

const initial: Position = { stream: 0, afterId: 0, afterSecond: 0, afterText: '', complete: 0 }
test.each([
  { stream: -1 },
  { stream: 12 },
  { stream: 0.5 },
  { stream: NaN },
  { stream: Infinity },
  { afterId: -1 },
  { afterId: 0.5 },
  { afterId: 9007199254740992 },
  { afterSecond: 1 },
  { stream: 8, afterId: 1 },
  { stream: 9, afterSecond: 1 },
  { stream: 10, afterText: 'a' },
  { stream: 10, afterId: 1, afterText: 100 },
  { stream: 10, afterId: 1, afterText: 'a'.repeat(101) },
  { complete: 2 }
])('persisted position refuses unsupported state %j', patch => {
  expect(valid({ ...initial, ...patch } as Position)).toBe(false)
})
test('position accepts the last stream, safe ID boundary, exact 100-codepoint 400-byte field and both relation components', () => {
  for (const state of [
    { ...initial, stream: 11, afterId: Number.MAX_SAFE_INTEGER, complete: 1 },
    { ...initial, stream: 10, afterId: 1, afterText: '😀'.repeat(100) },
    { ...initial, stream: 8, afterId: 1, afterSecond: 2 },
    { ...initial, stream: 9, afterId: 2, afterSecond: 1 }
  ])
    expect(valid(state)).toBe(true)
})

async function prepareStream(k: Knex, stream: number) {
  const plan = await installGeneration(k)
  await k(progress).update({ complete: 1 })
  await k(progress).where('stream', stream).update({ complete: 0 })
  return plan
}
const invalidSources: Array<{ table: string; stream: number; patch: Record<string, unknown>; message: string }> = [
  ...[0, -1, 9007199254740992].map(transactionId => ({
    table: 'transactions',
    stream: 0,
    patch: { transactionId },
    message: 'Invalid profile source identity'
  })),
  ...[0, 1.5, 'not an integer'].map(userId => ({
    table: 'transactions',
    stream: 0,
    patch: { userId },
    message: 'Invalid profile source identity'
  })),
  { table: 'tx_labels_map', stream: 8, patch: { txLabelId: 0 }, message: 'Invalid relation source identity' },
  { table: 'tx_labels_map', stream: 8, patch: { transactionId: 0 }, message: 'Invalid relation source identity' },
  { table: 'output_tags_map', stream: 9, patch: { outputTagId: -1 }, message: 'Invalid relation source identity' },
  { table: 'output_tags_map', stream: 9, patch: { outputId: 1.5 }, message: 'Invalid relation source identity' },
  {
    table: 'certificate_fields',
    stream: 10,
    patch: { certificateId: 0 },
    message: 'Invalid certificate source identity'
  },
  { table: 'certificate_fields', stream: 10, patch: { userId: 0 }, message: 'Invalid certificate source identity' },
  {
    table: 'certificate_fields',
    stream: 10,
    patch: { fieldName: 'a'.repeat(101) },
    message: 'Invalid certificate source identity'
  },
  {
    table: 'certificate_fields',
    stream: 10,
    patch: { fieldName: '😀'.repeat(101) },
    message: 'Invalid certificate source identity'
  },
  {
    table: 'certificate_fields',
    stream: 10,
    patch: { fieldName: Buffer.from('field') },
    message: 'Invalid certificate source identity'
  },
  { table: 'transactions', stream: 11, patch: { transactionId: 0 }, message: 'Invalid global source identity' },
  { table: 'transactions', stream: 11, patch: { userId: 0 }, message: 'Invalid global source identity' },
  { table: 'transactions', stream: 11, patch: { provenTxId: 0 }, message: 'Invalid global source identity' },
  { table: 'transactions', stream: 11, patch: { txid: 'a'.repeat(65) }, message: 'Invalid global source identity' },
  { table: 'transactions', stream: 11, patch: { txid: Buffer.from('txid') }, message: 'Invalid global source identity' }
]
test.each(invalidSources)(
  'historical $table identity refuses atomically at stream $stream: $patch',
  async ({ table, stream, patch, message }) => {
    const k = await fixture('BINARY', false, false)
    try {
      await k(table).insert({ ...value(table, 1, 1, 1), ...patch })
      const original = await k(table),
        plan = await prepareStream(k, stream),
        before = await k(progress).orderBy('stream')
      await expect(copyGenerationPage(k, plan)).rejects.toThrow(message)
      expect(await k(progress).orderBy('stream')).toEqual(before)
      expect(await k(table)).toEqual(original)
      for (const target of [names.profile, names.relation, names.certificate, names.edges])
        expect(await k(target)).toEqual([])
    } finally {
      await k.destroy()
    }
  }
)
test.each([
  ['tx_labels_map', 'tx_labels', 8, 'Invalid relation source owner'],
  ['output_tags_map', 'outputs', 9, 'Invalid relation source owner'],
  ['certificate_fields', 'certificates', 10, 'Invalid certificate source owner']
] as const)(
  'historical %s refuses invalid parent ownership and rolls back partial work',
  async (table, parent, stream, message) => {
    const k = await fixture('BINARY', false, false)
    try {
      await k(parent).insert(value(parent, 1, 1, 0))
      await k(table).insert(value(table, 1, 1, 1))
      const plan = await prepareStream(k, stream)
      await expect(copyGenerationPage(k, plan)).rejects.toThrow(message)
      expect(await k(progress).where('stream', stream).first()).toMatchObject({ ...initial, stream })
      expect(await k(stream === 10 ? names.certificate : names.relation)).toEqual([])
    } finally {
      await k.destroy()
    }
  }
)
test.each([{ provenTxReqId: 0 }, { provenTxId: 0 }])(
  'historical global request identity %j refuses before adding edges',
  async patch => {
    const k = await fixture('BINARY', false, false)
    try {
      await k('transactions').insert({ ...value('transactions', 1, 1, 1), provenTxId: null })
      await k('proven_tx_reqs').insert({ ...value('proven_tx_reqs', 1, 1, 1), ...patch })
      const plan = await prepareStream(k, 11)
      await expect(copyGenerationPage(k, plan)).rejects.toThrow('Invalid global request identity')
      expect(await k(names.edges)).toEqual([])
    } finally {
      await k.destroy()
    }
  }
)
test('asymmetric relation identities resolve each owner and retain the exact final tuple', async () => {
  const k = await fixture('BINARY', false, false)
  try {
    await k('tx_labels').insert(value('tx_labels', 2, 2, 3))
    await k('transactions').insert(value('transactions', 7, 7, 5))
    await k('tx_labels_map').insert([
      { txLabelId: 2, transactionId: 8 },
      { txLabelId: 2, transactionId: 7 },
      { txLabelId: 1, transactionId: 7 }
    ])
    const plan = await prepareStream(k, 8),
      page = await copyGenerationPage(k, plan)
    expect(page.copiedThrough).toEqual({ ...initial, stream: 8, afterId: 2, afterSecond: 8, complete: 1 })
    expect(await k(names.relation).orderBy(['snapshotLeftId', 'snapshotRightId', 'snapshotUserId'])).toEqual([
      { snapshotTableId: 0, snapshotUserId: 5, snapshotLeftId: 1, snapshotRightId: 7, snapshotMembership: 2 },
      { snapshotTableId: 0, snapshotUserId: 3, snapshotLeftId: 2, snapshotRightId: 7, snapshotMembership: 1 },
      { snapshotTableId: 0, snapshotUserId: 5, snapshotLeftId: 2, snapshotRightId: 7, snapshotMembership: 2 },
      { snapshotTableId: 0, snapshotUserId: 3, snapshotLeftId: 2, snapshotRightId: 8, snapshotMembership: 1 }
    ])
  } finally {
    await k.destroy()
  }
})
test('orphan fields keep their own profile and the maximum field spelling survives the cursor', async () => {
  const k = await fixture('BINARY', false, false)
  try {
    await k('certificate_fields').insert([
      { ...value('certificate_fields', 1, 7, 3), fieldName: '😀'.repeat(100) },
      { ...value('certificate_fields', 1, 2, 5), fieldName: 'a' }
    ])
    const plan = await prepareStream(k, 10),
      page = await copyGenerationPage(k, plan)
    expect(page.copiedThrough).toEqual({ ...initial, stream: 10, afterId: 7, afterText: '😀'.repeat(100), complete: 1 })
    expect(await k(names.certificate).orderBy('snapshotFieldName')).toEqual([
      { snapshotUserId: 5, snapshotCertificateId: 2, snapshotFieldName: 'a', snapshotMembership: 1 },
      { snapshotUserId: 3, snapshotCertificateId: 7, snapshotFieldName: '😀'.repeat(100), snapshotMembership: 1 }
    ])
  } finally {
    await k.destroy()
  }
})
test('unproven requests and null transaction IDs add only established global edges', async () => {
  const k = await fixture('BINARY', false, false)
  try {
    await k('transactions').insert([
      { ...value('transactions', 1, 1, 1), txid: null, provenTxId: null },
      { ...value('transactions', 2, 2, 2), provenTxId: null }
    ])
    await k('proven_tx_reqs').insert({ ...value('proven_tx_reqs', 5, 2, 1), provenTxId: null })
    const plan = await prepareStream(k, 11)
    await copyGenerationPage(k, plan)
    expect(await k(names.edges)).toEqual([{ transactionId: 2, requestId: 5, tableId: 0, rowId: 5, userId: 2 }])
    expect(await k(names.guards)).toEqual([])
  } finally {
    await k.destroy()
  }
})
test.each(['missing', 'extra', 'wrong stream', 'second cursor', 'binary text'])(
  'corrupt %s progress refuses both copying and publication',
  async kind => {
    const k = await fixture('BINARY', false, false)
    try {
      const plan = await installGeneration(k)
      if (kind === 'missing') await k(progress).where('stream', 11).delete()
      if (kind === 'extra') await k(progress).insert({ ...initial, stream: 12 })
      if (kind === 'wrong stream') await k(progress).where('stream', 0).update({ stream: 12 })
      if (kind === 'second cursor') await k(progress).where('stream', 0).update({ afterSecond: 1 })
      if (kind === 'binary text')
        await k(progress)
          .where('stream', 10)
          .update({ afterId: 1, afterText: Buffer.from('a') })
      const before = await k(progress).orderBy('stream')
      await expect(copyGenerationPage(k, plan)).rejects.toThrow('Invalid generation progress')
      await expect(readGenerationIndexState(k)).rejects.toThrow('Invalid generation progress')
      expect(await k(progress).orderBy('stream')).toEqual(before)
    } finally {
      await k.destroy()
    }
  }
)
test('publication requires its configured schema journal and all completed streams', async () => {
  const k = await fixture('BINARY', false, false)
  try {
    const plan = await installGeneration(k)
    await k(progress).update({ complete: 1 })
    await copyGenerationPage(k, plan)
    await k.raw("ATTACH DATABASE ':memory:' AS release_registry")
    await k.schema.withSchema('release_registry').createTable('published', table => {
      table.string('name').notNullable()
    })
    const config = { schemaName: 'release_registry', tableName: 'published' }
    await k.schema.createTable('published', table => {
      table.string('name').notNullable()
    })
    await k('published').insert({ name: migration })
    expect(await readGenerationIndexState(k, config)).toBe(false)
    await k('published').withSchema('release_registry').insert({ name: migration })
    expect(await readGenerationIndexState(k, config)).toBe('v2')
    await k(metadata).update({ complete: 0 })
    await expect(readGenerationIndexState(k, config)).rejects.toThrow('Published generation is incomplete')
    await k(metadata).update({ complete: 1 })
    await k(progress).where('stream', 4).update({ complete: 0 })
    await expect(readGenerationIndexState(k, config)).rejects.toThrow('Completed generation has unfinished streams')
    await k(progress).update({ complete: 1 })
    await k.schema.withSchema('release_registry').dropTable('published')
    expect(await readGenerationIndexState(k, config)).toBe(false)
  } finally {
    await k.destroy()
  }
})
