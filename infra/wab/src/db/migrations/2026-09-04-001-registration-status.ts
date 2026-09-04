import { Knex } from 'knex'

export async function up(knex: Knex): Promise<void> {
  await knex.schema.alterTable('users', table => {
    // Existing rows predate the two-phase registration protocol and must stay
    // fail-closed. Only WAB-created registrations explicitly enter `pending`.
    table.string('registrationStatus', 16).notNullable().defaultTo('active')
  })
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.alterTable('users', table => {
    table.dropColumn('registrationStatus')
  })
}
