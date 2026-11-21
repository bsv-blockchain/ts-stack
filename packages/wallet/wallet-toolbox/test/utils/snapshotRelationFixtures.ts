import { knex, type Knex } from 'knex'
import { runInSeries } from '../../src/utility/runInSeries'

// Independent fixture definitions and source-derived oracle, rather than the
// migration's relation registry or trigger expressions.
export const relationFixtures = [
  { table: 'tx_labels_map', left: 'tx_labels', leftKey: 'txLabelId', right: 'transactions', rightKey: 'transactionId' },
  { table: 'output_tags_map', left: 'output_tags', leftKey: 'outputTagId', right: 'outputs', rightKey: 'outputId' }
] as const

export async function minimalRelationDatabase(): Promise<Knex> {
  const k = knex({
    client: 'better-sqlite3',
    connection: { filename: ':memory:' },
    useNullAsDefault: true,
    pool: { min: 1, max: 1 }
  })
  try {
    await runInSeries(relationFixtures, async relation => {
      await runInSeries(
        [
          [relation.left, relation.leftKey],
          [relation.right, relation.rightKey]
        ],
        async ([table, key]) => {
          await k.schema.createTable(table, t => {
            t.integer(key).primary()
            t.integer('userId').notNullable()
          })
        }
      )
      await k.schema.createTable(relation.table, t => {
        t.integer(relation.leftKey)
        t.integer(relation.rightKey)
        t.boolean('isDeleted')
        t.primary([relation.leftKey, relation.rightKey])
        t.index(relation.rightKey)
      })
    })
    return k
  } catch (error) {
    await k.destroy()
    throw error
  }
}

export async function expectRelationMembership(k: Knex): Promise<void> {
  const expected: Array<Record<string, number>> = []
  await runInSeries(relationFixtures.entries(), async ([tableId, relation]) => {
    const left = new Map<number, number>((await k(relation.left)).map(row => [row[relation.leftKey], row.userId]))
    const right = new Map<number, number>((await k(relation.right)).map(row => [row[relation.rightKey], row.userId]))
    for (const row of await k(relation.table)) {
      const owners = new Map<number, number>()
      for (const [userId, bit] of [
        [left.get(row[relation.leftKey]), 1],
        [right.get(row[relation.rightKey]), 2]
      ]) {
        if (userId !== undefined && bit !== undefined) owners.set(userId, (owners.get(userId) ?? 0) | bit)
      }
      for (const [userId, membership] of owners)
        expected.push({
          snapshotTableId: tableId,
          snapshotUserId: userId,
          snapshotLeftId: row[relation.leftKey],
          snapshotRightId: row[relation.rightKey],
          snapshotMembership: membership
        })
    }
  })
  expected.sort(
    (a, b) =>
      a.snapshotTableId - b.snapshotTableId ||
      a.snapshotUserId - b.snapshotUserId ||
      a.snapshotLeftId - b.snapshotLeftId ||
      a.snapshotRightId - b.snapshotRightId
  )
  expect(
    await k('snapshot_relation_keys').orderBy([
      'snapshotTableId',
      'snapshotUserId',
      'snapshotLeftId',
      'snapshotRightId'
    ])
  ).toEqual(expected)
}
