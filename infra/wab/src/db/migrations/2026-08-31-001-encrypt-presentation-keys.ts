import type { Knex } from 'knex'
import {
  decryptPresentationKey,
  hasPresentationKeyVaultKey,
  isRedactedPresentationKey
} from '../../security/presentationKeyVault'

interface LegacyUserRow {
  id: number
  presentationKey: string
  pendingPresentationKey: string | null
  presentationKeyCiphertext: string | null
  pendingPresentationKeyCiphertext: string | null
}

interface HistoryRow {
  id: number
  previousPresentationKey: string
  newPresentationKey: string
  previousPresentationKeyCiphertext: string | null
  newPresentationKeyCiphertext: string | null
}

export async function up(knex: Knex): Promise<void> {
  await knex.schema.alterTable('users', table => {
    table.string('presentationKeyLookup', 64).nullable().unique()
    table.text('presentationKeyCiphertext').nullable()
    table.string('pendingPresentationKeyLookup', 64).nullable().index()
    table.text('pendingPresentationKeyCiphertext').nullable()
  })
  await knex.schema.alterTable('phone_change_history', table => {
    table.text('previousPresentationKeyCiphertext').nullable()
    table.text('newPresentationKeyCiphertext').nullable()
  })

  // This migration is deliberately schema-only. Existing WAB binaries ignore the
  // nullable sidecar columns, so it is safe to apply before a rolling deployment.
}

export async function down(knex: Knex): Promise<void> {
  const users = await knex<LegacyUserRow>('users').select('*')
  for (const user of users) {
    const update: Record<string, string | null> = {}
    if (isRedactedPresentationKey(user.presentationKey)) {
      if (user.presentationKeyCiphertext == null || !hasPresentationKeyVaultKey()) {
        throw new Error(
          'Cannot remove presentation-key vault columns without restoring redacted keys.'
        )
      }
      update.presentationKey = decryptPresentationKey(user.presentationKeyCiphertext)
    }
    if (user.pendingPresentationKey == null && user.pendingPresentationKeyCiphertext != null) {
      if (!hasPresentationKeyVaultKey()) {
        throw new Error(
          'Cannot remove presentation-key vault columns without restoring pending keys.'
        )
      }
      update.pendingPresentationKey = decryptPresentationKey(user.pendingPresentationKeyCiphertext)
    }
    if (Object.keys(update).length > 0) await knex('users').where({ id: user.id }).update(update)
  }

  const history = await knex<HistoryRow>('phone_change_history').select('*')
  for (const row of history) {
    const update: Record<string, string> = {}
    if (isRedactedPresentationKey(row.previousPresentationKey)) {
      if (row.previousPresentationKeyCiphertext == null || !hasPresentationKeyVaultKey()) {
        throw new Error(
          'Cannot remove presentation-key vault columns without restoring key history.'
        )
      }
      update.previousPresentationKey = decryptPresentationKey(row.previousPresentationKeyCiphertext)
    }
    if (isRedactedPresentationKey(row.newPresentationKey)) {
      if (row.newPresentationKeyCiphertext == null || !hasPresentationKeyVaultKey()) {
        throw new Error(
          'Cannot remove presentation-key vault columns without restoring key history.'
        )
      }
      update.newPresentationKey = decryptPresentationKey(row.newPresentationKeyCiphertext)
    }
    if (Object.keys(update).length > 0) {
      await knex('phone_change_history').where({ id: row.id }).update(update)
    }
  }

  await knex.schema.alterTable('phone_change_history', table => {
    table.dropColumn('previousPresentationKeyCiphertext')
    table.dropColumn('newPresentationKeyCiphertext')
  })
  await knex.schema.alterTable('users', table => {
    table.dropColumn('presentationKeyLookup')
    table.dropColumn('presentationKeyCiphertext')
    table.dropColumn('pendingPresentationKeyLookup')
    table.dropColumn('pendingPresentationKeyCiphertext')
  })
}
