import type { Knex } from 'knex'

function binaryLargeType(knex: Knex): string {
  const client = String(knex.client.config.client ?? '').toLowerCase()
  if (client.includes('mysql')) return 'longblob'
  if (client.includes('pg')) return 'bytea'
  return 'blob'
}

async function addColumnIfMissing(
  knex: Knex,
  tableName: string,
  columnName: string,
  addColumn: (table: Knex.TableBuilder) => void
): Promise<void> {
  const exists = await knex.schema.hasColumn(tableName, columnName)
  if (!exists) {
    await knex.schema.table(tableName, addColumn)
  }
}

export async function up(knex: Knex): Promise<void> {
  await addColumnIfMissing(knex, 'applied_transactions', 'blockHeight', table => {
    table.integer('blockHeight').unsigned().nullable()
  })
  await addColumnIfMissing(knex, 'applied_transactions', 'blockHash', table => {
    table.string('blockHash', 64).nullable()
  })
  await addColumnIfMissing(knex, 'applied_transactions', 'blockIndex', table => {
    table.integer('blockIndex').unsigned().nullable()
  })
  await addColumnIfMissing(knex, 'applied_transactions', 'merkleRoot', table => {
    table.string('merkleRoot', 64).nullable()
  })
  await addColumnIfMissing(knex, 'applied_transactions', 'firstSeenHeight', table => {
    table.integer('firstSeenHeight').unsigned().nullable()
  })
  await addColumnIfMissing(knex, 'applied_transactions', 'proven', table => {
    table.boolean('proven').notNullable().defaultTo(false)
  })

  await addColumnIfMissing(knex, 'transactions', 'rawTx', table => {
    table.specificType('rawTx', binaryLargeType(knex)).nullable()
  })
  await addColumnIfMissing(knex, 'transactions', 'merklePath', table => {
    table.specificType('merklePath', binaryLargeType(knex)).nullable()
  })
  await addColumnIfMissing(knex, 'transactions', 'blockHeight', table => {
    table.integer('blockHeight').unsigned().nullable()
  })
  await addColumnIfMissing(knex, 'transactions', 'blockHash', table => {
    table.string('blockHash', 64).nullable()
  })
  await addColumnIfMissing(knex, 'transactions', 'blockIndex', table => {
    table.integer('blockIndex').unsigned().nullable()
  })
  await addColumnIfMissing(knex, 'transactions', 'merkleRoot', table => {
    table.string('merkleRoot', 64).nullable()
  })
  await addColumnIfMissing(knex, 'transactions', 'updatedAt', table => {
    table.timestamp('updatedAt').nullable()
  })

  const topicBlockAnchorsExists = await knex.schema.hasTable('topic_block_anchors')
  if (!topicBlockAnchorsExists) {
    await knex.schema.createTable('topic_block_anchors', table => {
      table.increments()
      table.string('topic').notNullable()
      table.integer('blockHeight').unsigned().notNullable()
      table.string('blockHash', 64).notNullable()
      table.string('basmRoot', 64).notNullable()
      table.integer('admittedCount').unsigned().notNullable()
      table.string('tac', 64).notNullable()
      table.timestamp('updatedAt').nullable()
      table.unique(['topic', 'blockHeight'], 'idx_topic_block_anchors_topic_height_unique')
      table.index(['topic', 'blockHeight'], 'idx_topic_block_anchors_topic_height')
      table.index(['topic', 'blockHash'], 'idx_topic_block_anchors_topic_hash')
    })
  }

  const syncStateExists = await knex.schema.hasTable('basm_sync_state')
  if (!syncStateExists) {
    await knex.schema.createTable('basm_sync_state', table => {
      table.string('host').notNullable()
      table.string('topic').notNullable()
      table.integer('lastHeight').unsigned().notNullable().defaultTo(0)
      table.timestamp('updatedAt').nullable()
      table.primary(['host', 'topic'])
      table.index('topic')
    })
  }

  const appliedTopicHeightIndex = 'idx_applied_transactions_topic_height'
  const hasAppliedTopicHeightIndex = await knex.schema.hasTable('applied_transactions')
  if (hasAppliedTopicHeightIndex) {
    await knex.schema.table('applied_transactions', table => {
      table.index(['topic', 'blockHeight', 'blockHash', 'blockIndex'], appliedTopicHeightIndex)
      table.index(['topic', 'proven', 'firstSeenHeight'], 'idx_applied_transactions_unproven')
    })
  }
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists('basm_sync_state')
  await knex.schema.dropTableIfExists('topic_block_anchors')

  await knex.schema.table('applied_transactions', table => {
    table.dropIndex(['topic', 'blockHeight', 'blockHash', 'blockIndex'], 'idx_applied_transactions_topic_height')
    table.dropIndex(['topic', 'proven', 'firstSeenHeight'], 'idx_applied_transactions_unproven')
  })

  for (const column of ['updatedAt', 'merkleRoot', 'blockIndex', 'blockHash', 'blockHeight', 'merklePath', 'rawTx']) {
    if (await knex.schema.hasColumn('transactions', column)) {
      await knex.schema.table('transactions', table => table.dropColumn(column))
    }
  }

  for (const column of ['proven', 'firstSeenHeight', 'merkleRoot', 'blockIndex', 'blockHash', 'blockHeight']) {
    if (await knex.schema.hasColumn('applied_transactions', column)) {
      await knex.schema.table('applied_transactions', table => table.dropColumn(column))
    }
  }
}
