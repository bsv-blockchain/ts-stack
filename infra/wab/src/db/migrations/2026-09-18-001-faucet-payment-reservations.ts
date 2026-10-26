import type { Knex } from 'knex'

export const faucetPaymentUserUnique = 'payments_user_id_unique'
export const faucetPaymentRollbackMessage =
  'Cannot remove the WAB faucet payment reservation schema while payment evidence exists.'

interface IndexDefinition {
  unique: boolean
  columns: string[]
}

interface SqliteIndexListRow {
  name: string
  unique: number
}

interface SqliteIndexInfoRow {
  seqno: number
  name: string
}

interface MysqlIndexRow {
  Non_unique: number | string
  Seq_in_index: number | string
  Column_name: string
}

function clientName(knex: Knex): string {
  return String(knex.client.config.client).toLowerCase()
}

async function inspectFaucetPaymentIndex(knex: Knex): Promise<IndexDefinition | undefined> {
  const client = clientName(knex)
  if (client === 'sqlite3' || client === 'better-sqlite3') {
    const indexes = (await knex.raw('PRAGMA index_list("payments")')) as SqliteIndexListRow[]
    const index = indexes.find(candidate => candidate.name === faucetPaymentUserUnique)
    if (index == null) return undefined

    const columns = (await knex.raw(
      `PRAGMA index_info("${faucetPaymentUserUnique}")`
    )) as SqliteIndexInfoRow[]
    columns.sort((left, right) => left.seqno - right.seqno)
    return {
      unique: Number(index.unique) === 1,
      columns: columns.map(column => column.name)
    }
  }

  if (client === 'mysql' || client === 'mysql2') {
    const [rows] = (await knex.raw('SHOW INDEX FROM ?? WHERE Key_name = ?', [
      'payments',
      faucetPaymentUserUnique
    ])) as [MysqlIndexRow[], unknown]
    if (rows.length === 0) return undefined

    rows.sort((left, right) => Number(left.Seq_in_index) - Number(right.Seq_in_index))
    return {
      unique: rows.every(row => Number(row.Non_unique) === 0),
      columns: rows.map(row => row.Column_name)
    }
  }

  throw new Error(`Unsupported WAB migration database client: ${client}`)
}

function assertExpectedFaucetPaymentIndex(index: IndexDefinition | undefined): void {
  if (
    index == null ||
    !index.unique ||
    index.columns.length !== 1 ||
    index.columns[0] !== 'userId'
  ) {
    throw new Error(
      `WAB faucet payment migration requires ${faucetPaymentUserUnique} to be a unique userId index.`
    )
  }
}

function normalizeDefault(value: unknown): string {
  const rendered = String(value).trim()
  if (
    rendered.length >= 2 &&
    ((rendered.startsWith("'") && rendered.endsWith("'")) ||
      (rendered.startsWith('"') && rendered.endsWith('"')))
  ) {
    return rendered.slice(1, -1)
  }
  return rendered
}

async function assertExpectedStatusColumn(knex: Knex): Promise<void> {
  const info = (await knex('payments').columnInfo('status')) as {
    type?: unknown
    maxLength?: unknown
    nullable?: unknown
    defaultValue?: unknown
  }
  const type = String(info.type).toLowerCase()
  if (
    (type !== 'varchar' && type !== 'character varying') ||
    Number(info.maxLength) !== 16 ||
    info.nullable !== false ||
    normalizeDefault(info.defaultValue) !== 'ready'
  ) {
    throw new Error('WAB faucet payment migration found an incompatible payments.status column.')
  }
}

async function assertNoDuplicatePaymentUsers(knex: Knex): Promise<void> {
  const duplicate = await knex('payments')
    .select('userId')
    .count({ count: '*' })
    .whereNotNull('userId')
    .groupBy('userId')
    .havingRaw('COUNT(*) > 1')
    .first()
  if (duplicate) {
    throw new Error(
      'Duplicate WAB faucet payments require operator reconciliation before this migration can continue.'
    )
  }
}

export async function up(knex: Knex): Promise<void> {
  await assertNoDuplicatePaymentUsers(knex)

  if (await knex.schema.hasColumn('payments', 'status')) {
    await assertExpectedStatusColumn(knex)
  } else {
    // Keep the two DDL changes separate. MySQL commits each ALTER TABLE, so a
    // retry must be able to resume after either statement completed.
    await knex.schema.alterTable('payments', table => {
      table.string('status', 16).notNullable().defaultTo('ready')
    })
  }
  await assertExpectedStatusColumn(knex)

  const existingIndex = await inspectFaucetPaymentIndex(knex)
  if (existingIndex == null) {
    await knex.schema.alterTable('payments', table => {
      table.unique(['userId'], faucetPaymentUserUnique)
    })
  } else {
    assertExpectedFaucetPaymentIndex(existingIndex)
  }

  assertExpectedFaucetPaymentIndex(await inspectFaucetPaymentIndex(knex))
}

export async function down(knex: Knex): Promise<void> {
  const payment = await knex('payments').select('id').first()
  if (payment != null) throw new Error(faucetPaymentRollbackMessage)

  const existingIndex = await inspectFaucetPaymentIndex(knex)
  if (existingIndex != null) {
    assertExpectedFaucetPaymentIndex(existingIndex)
    await knex.schema.alterTable('payments', table => {
      table.dropUnique(['userId'], faucetPaymentUserUnique)
    })
  }

  if (await knex.schema.hasColumn('payments', 'status')) {
    await assertExpectedStatusColumn(knex)
    await knex.schema.alterTable('payments', table => {
      table.dropColumn('status')
    })
  }

  if (
    (await knex.schema.hasColumn('payments', 'status')) ||
    (await inspectFaucetPaymentIndex(knex)) != null
  ) {
    throw new Error('WAB faucet payment reservation schema rollback did not complete.')
  }
}
