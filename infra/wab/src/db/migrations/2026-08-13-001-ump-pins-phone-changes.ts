import { Knex } from 'knex'

export async function up(knex: Knex): Promise<void> {
  await knex.schema.alterTable('users', table => {
    table.string('umpTokenOutpoint', 75).nullable()
    table.string('pendingPresentationKey', 64).nullable()
  })

  await knex.schema.createTable('phone_change_history', table => {
    table.increments('id').primary()
    table
      .integer('targetUserId')
      .unsigned()
      .nullable()
      .references('id')
      .inTable('users')
      .onDelete('SET NULL')
    table
      .integer('phoneAuthMethodId')
      .unsigned()
      .nullable()
      .references('id')
      .inTable('auth_methods')
      .onDelete('SET NULL')
    table
      .integer('previousPhoneOwnerUserId')
      .unsigned()
      .nullable()
      .references('id')
      .inTable('users')
      .onDelete('SET NULL')
    table
      .integer('replacedAuthMethodId')
      .unsigned()
      .nullable()
      .references('id')
      .inTable('auth_methods')
      .onDelete('SET NULL')
    table.string('methodType', 64).notNullable()
    table.string('config', 255).notNullable()
    table.string('previousPresentationKey', 64).notNullable()
    table.string('newPresentationKey', 64).notNullable()
    table.bigInteger('createdAtEpochMs').notNullable()
    table.bigInteger('finalizedAtEpochMs').nullable()
    table.bigInteger('restoredAtEpochMs').nullable()
    table.index(['methodType', 'config', 'createdAtEpochMs'], 'phone_change_history_identity_idx')
    table.index(['targetUserId', 'createdAtEpochMs'], 'phone_change_history_target_idx')
  })

  await knex.schema.createTable('phone_change_sessions', table => {
    table.increments('id').primary()
    table.string('tokenHash', 64).notNullable().unique()
    table
      .integer('userId')
      .unsigned()
      .nullable()
      .references('id')
      .inTable('users')
      .onDelete('SET NULL')
    table.string('methodType', 64).notNullable()
    table.string('config', 255).notNullable()
    table.bigInteger('expiresAtEpochMs').notNullable()
    table.bigInteger('consumedAtEpochMs').nullable()
    table
      .integer('committedChangeId')
      .unsigned()
      .nullable()
      .references('id')
      .inTable('phone_change_history')
      .onDelete('SET NULL')
    table.bigInteger('createdAtEpochMs').notNullable()
    table.index(['expiresAtEpochMs', 'consumedAtEpochMs'], 'phone_change_sessions_expiry_idx')
  })
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists('phone_change_sessions')
  await knex.schema.dropTableIfExists('phone_change_history')
  await knex.schema.alterTable('users', table => {
    table.dropColumn('pendingPresentationKey')
    table.dropColumn('umpTokenOutpoint')
  })
}
