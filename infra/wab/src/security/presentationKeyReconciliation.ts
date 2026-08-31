import type { Knex } from 'knex'
import {
  decryptPresentationKey,
  encryptPresentationKey,
  isRedactedPresentationKey,
  presentationKeyLookup,
  presentationKeyVaultMode,
  redactedPresentationKey,
  type PresentationKeyVaultMode
} from './presentationKeyVault'

const BATCH_SIZE = 500

interface UserVaultRow {
  id: number
  presentationKey: string
  presentationKeyLookup: string | null
  presentationKeyCiphertext: string | null
  pendingPresentationKey: string | null
  pendingPresentationKeyLookup: string | null
  pendingPresentationKeyCiphertext: string | null
}

interface HistoryVaultRow {
  id: number
  previousPresentationKey: string
  previousPresentationKeyCiphertext: string | null
  newPresentationKey: string
  newPresentationKeyCiphertext: string | null
}

export interface PresentationKeyReconciliationResult {
  mode: PresentationKeyVaultMode
  usersUpdated: number
  historyRowsUpdated: number
}

function isPresentationKey(value: string | null | undefined): value is string {
  return typeof value === 'string' && /^[0-9a-fA-F]{64}$/.test(value)
}

function matchingCiphertext(ciphertext: string | null, key: string): string | undefined {
  if (ciphertext == null) return undefined
  try {
    return decryptPresentationKey(ciphertext) === key ? ciphertext : undefined
  } catch {
    return undefined
  }
}

function keyFromCiphertext(ciphertext: string | null, description: string): string {
  if (ciphertext == null) throw new Error(`${description} is redacted without encrypted key data.`)
  return decryptPresentationKey(ciphertext)
}

function setIfChanged(
  update: Record<string, string | null>,
  column: string,
  current: string | null,
  next: string | null
): void {
  if (current !== next) update[column] = next
}

function userUpdate(row: UserVaultRow, mode: Exclude<PresentationKeyVaultMode, 'legacy'>) {
  const update: Record<string, string | null> = {}
  const primaryWasRedacted = isRedactedPresentationKey(row.presentationKey)
  const plaintextPrimary = isPresentationKey(row.presentationKey)
    ? row.presentationKey
    : primaryWasRedacted
      ? keyFromCiphertext(row.presentationKeyCiphertext, `User ${row.id} presentation key`)
      : undefined

  // Shamir-only rows deliberately retain their non-key legacy placeholder.
  if (plaintextPrimary != null) {
    const lookup = presentationKeyLookup(plaintextPrimary)
    const ciphertext =
      matchingCiphertext(row.presentationKeyCiphertext, plaintextPrimary) ??
      encryptPresentationKey(plaintextPrimary)
    setIfChanged(update, 'presentationKeyLookup', row.presentationKeyLookup, lookup)
    setIfChanged(update, 'presentationKeyCiphertext', row.presentationKeyCiphertext, ciphertext)
    if (mode === 'dual-write') {
      setIfChanged(update, 'presentationKey', row.presentationKey, plaintextPrimary)
    } else if (!primaryWasRedacted) {
      update.presentationKey = redactedPresentationKey(row.id)
    }
  }

  let plaintextPending: string | undefined
  if (isPresentationKey(row.pendingPresentationKey)) {
    plaintextPending = row.pendingPresentationKey
  } else if (
    row.pendingPresentationKeyCiphertext != null &&
    (mode === 'encrypted' || primaryWasRedacted)
  ) {
    plaintextPending = decryptPresentationKey(row.pendingPresentationKeyCiphertext)
  }

  if (plaintextPending == null) {
    if (mode === 'dual-write') {
      setIfChanged(update, 'pendingPresentationKeyLookup', row.pendingPresentationKeyLookup, null)
      setIfChanged(
        update,
        'pendingPresentationKeyCiphertext',
        row.pendingPresentationKeyCiphertext,
        null
      )
    }
  } else {
    const lookup = presentationKeyLookup(plaintextPending)
    const ciphertext =
      matchingCiphertext(row.pendingPresentationKeyCiphertext, plaintextPending) ??
      encryptPresentationKey(plaintextPending)
    setIfChanged(update, 'pendingPresentationKeyLookup', row.pendingPresentationKeyLookup, lookup)
    setIfChanged(
      update,
      'pendingPresentationKeyCiphertext',
      row.pendingPresentationKeyCiphertext,
      ciphertext
    )
    setIfChanged(
      update,
      'pendingPresentationKey',
      row.pendingPresentationKey,
      mode === 'dual-write' ? plaintextPending : null
    )
  }
  return update
}

function historyUpdate(row: HistoryVaultRow, mode: Exclude<PresentationKeyVaultMode, 'legacy'>) {
  const update: Record<string, string | null> = {}
  const previousWasRedacted = isRedactedPresentationKey(row.previousPresentationKey)
  const nextWasRedacted = isRedactedPresentationKey(row.newPresentationKey)
  const previous = isPresentationKey(row.previousPresentationKey)
    ? row.previousPresentationKey
    : keyFromCiphertext(
        row.previousPresentationKeyCiphertext,
        `Phone-change history ${row.id} previous key`
      )
  const next = isPresentationKey(row.newPresentationKey)
    ? row.newPresentationKey
    : keyFromCiphertext(row.newPresentationKeyCiphertext, `Phone-change history ${row.id} new key`)
  const previousCiphertext =
    matchingCiphertext(row.previousPresentationKeyCiphertext, previous) ??
    encryptPresentationKey(previous)
  const nextCiphertext =
    matchingCiphertext(row.newPresentationKeyCiphertext, next) ?? encryptPresentationKey(next)

  setIfChanged(
    update,
    'previousPresentationKeyCiphertext',
    row.previousPresentationKeyCiphertext,
    previousCiphertext
  )
  setIfChanged(
    update,
    'newPresentationKeyCiphertext',
    row.newPresentationKeyCiphertext,
    nextCiphertext
  )
  if (mode === 'dual-write') {
    setIfChanged(update, 'previousPresentationKey', row.previousPresentationKey, previous)
    setIfChanged(update, 'newPresentationKey', row.newPresentationKey, next)
  } else {
    if (!previousWasRedacted) {
      update.previousPresentationKey = redactedPresentationKey(row.id, 'previous')
    }
    if (!nextWasRedacted) {
      update.newPresentationKey = redactedPresentationKey(row.id, 'new')
    }
  }
  return update
}

async function reconcileUsers(
  knex: Knex,
  mode: Exclude<PresentationKeyVaultMode, 'legacy'>
): Promise<number> {
  let lastId = 0
  let updated = 0
  while (true) {
    let batchLength = 0
    let nextLastId = lastId
    await knex.transaction(async trx => {
      const batch = await trx<UserVaultRow>('users')
        .where('id', '>', lastId)
        .orderBy('id', 'asc')
        .limit(BATCH_SIZE)
        .forUpdate()
      batchLength = batch.length
      if (batch.length === 0) return
      for (const row of batch) {
        const update = userUpdate(row, mode)
        if (Object.keys(update).length > 0) {
          await trx('users').where({ id: row.id }).update(update)
          updated += 1
        }
      }
      nextLastId = batch[batch.length - 1].id
    })
    if (batchLength === 0) return updated
    lastId = nextLastId
  }
}

async function reconcileHistory(
  knex: Knex,
  mode: Exclude<PresentationKeyVaultMode, 'legacy'>
): Promise<number> {
  let lastId = 0
  let updated = 0
  while (true) {
    let batchLength = 0
    let nextLastId = lastId
    await knex.transaction(async trx => {
      const batch = await trx<HistoryVaultRow>('phone_change_history')
        .where('id', '>', lastId)
        .orderBy('id', 'asc')
        .limit(BATCH_SIZE)
        .forUpdate()
      batchLength = batch.length
      if (batch.length === 0) return
      for (const row of batch) {
        const update = historyUpdate(row, mode)
        if (Object.keys(update).length > 0) {
          await trx('phone_change_history').where({ id: row.id }).update(update)
          updated += 1
        }
      }
      nextLastId = batch[batch.length - 1].id
    })
    if (batchLength === 0) return updated
    lastId = nextLastId
  }
}

export async function reconcilePresentationKeyVault(
  knex: Knex
): Promise<PresentationKeyReconciliationResult> {
  const mode = presentationKeyVaultMode()
  if (mode === 'legacy') return { mode, usersUpdated: 0, historyRowsUpdated: 0 }
  return {
    mode,
    usersUpdated: await reconcileUsers(knex, mode),
    historyRowsUpdated: await reconcileHistory(knex, mode)
  }
}
