import type { PackedIdbDatabase, PackedIdbTransaction } from './idbPackedFields'

/** Only the explicit, new isolated restore namespace owns these stores. No
 * existing v6/v7 wallet is upgraded or selected by these definitions. */
export const idbImportJournalStores = Object.freeze({
  journal: '_brc38_restore_journal',
  ids: '_brc38_restore_ids',
  originals: '_brc38_restore_originals'
})
export function isIdbRestoreDatabaseName(name: string): boolean {
  return /^wallet-toolbox-(main|test)net-restore-v1-[0-9a-f]{32}$/.test(name)
}
export function upgradeIdbImportJournal(db: PackedIdbDatabase): void {
  if (!isIdbRestoreDatabaseName(db.name)) throw new Error('Import journal requires its isolated restore namespace')
  for (const name of Object.values(idbImportJournalStores))
    if (db.objectStoreNames.contains(name)) throw new Error('Import journal stores already exist')
  db.createObjectStore(idbImportJournalStores.journal)
  db.createObjectStore(idbImportJournalStores.ids, { keyPath: ['entity', 'incomingId'] })
  db.createObjectStore(idbImportJournalStores.originals, { keyPath: ['table', 'index'] }).createIndex(
    'references',
    'references',
    { multiEntry: true }
  )
}
/** Fresh definitions in the actual current transaction; never a cached schema
 * match. These constants specify the format, and confer no ownership. */
export function verifyIdbImportJournalSchema(tx: PackedIdbTransaction): void {
  if (!isIdbRestoreDatabaseName(tx.db.name) || tx.db.version !== 7)
    throw new Error('Import journal current database differs')
  for (const [name, key] of [
    [idbImportJournalStores.journal, null],
    [idbImportJournalStores.ids, ['entity', 'incomingId']],
    [idbImportJournalStores.originals, ['table', 'index']]
  ] as const) {
    const store = tx.objectStore(name)
    if (
      store.autoIncrement ||
      store.indexNames.length !== (name === idbImportJournalStores.originals ? 1 : 0) ||
      JSON.stringify(store.keyPath) !== JSON.stringify(key)
    )
      throw new Error('Import journal current store definition differs')
    if (name === idbImportJournalStores.originals) {
      if (!store.indexNames.contains('references')) throw new Error('Import journal current reference index differs')
      const index = store.index('references')
      if (index.unique || !index.multiEntry || index.keyPath !== 'references')
        throw new Error('Import journal current reference index differs')
    }
  }
}
