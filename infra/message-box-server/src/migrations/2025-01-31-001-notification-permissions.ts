import { Knex } from 'knex'

export async function up(knex: Knex): Promise<void> {
  // Create generalized message permissions table for all box/sender combinations
  await knex.schema.createTable('message_permissions', (table) => {
    table.increments('id').primary()
    table.timestamp('created_at').defaultTo(knex.fn.now())
    table.timestamp('updated_at').defaultTo(knex.fn.now())
    table.string('recipient', 255).notNullable() // identityKey of who this permission belongs to
    table.string('sender', 255).nullable() // identityKey of sender (NULL for box-wide defaults)
    table.string('message_box', 255).notNullable() // messageBox type (e.g., 'notifications', 'inbox', etc.)
    table.integer('recipient_fee').notNullable() // -1 = block all, 0 = always allow, >0 = satoshi amount required

    table.unique(['recipient', 'sender', 'message_box'])

    table.index('recipient')
    table.index(['recipient', 'message_box'])
    table.index('message_box')
    table.index('sender')
  })

  // Create server fee configuration table
  await knex.schema.createTable('server_fees', (table) => {
    table.increments('id').primary()
    table.timestamp('created_at').defaultTo(knex.fn.now())
    table.timestamp('updated_at').defaultTo(knex.fn.now())
    table.string('message_box').notNullable() // messageBox type
    table.integer('delivery_fee').notNullable() // Server delivery fee in satoshis
    table.unique(['message_box']) // Each box type can only have one server fee setting
  })

  // Insert default server fees for different message box types
  const existingFees = await knex('server_fees').select('message_box')
  const existingMessageBoxes = existingFees.map(fee => fee.message_box)

  const defaultFees = [
    {
      message_box: 'notifications',
      delivery_fee: 10, // Higher fee for FCM delivery
      created_at: new Date(),
      updated_at: new Date()
    },
    {
      message_box: 'inbox',
      delivery_fee: 0, // Free for regular inbox
      created_at: new Date(),
      updated_at: new Date()
    },
    {
      message_box: 'payment_inbox',
      delivery_fee: 0, // Free for payment inbox
      created_at: new Date(),
      updated_at: new Date()
    }
  ]

  // Only insert fees for message boxes that don't already exist
  const feesToInsert = defaultFees.filter(fee => !existingMessageBoxes.includes(fee.message_box))

  if (feesToInsert.length > 0) {
    await knex('server_fees').insert(feesToInsert)
  }
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists('server_fees')
  await knex.schema.dropTableIfExists('message_permissions')
}
