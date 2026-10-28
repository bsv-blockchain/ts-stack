import { boundedJson, isSha, isUuid, integer, invalid } from './Brc38ImportJournalContract'
import { isIdbRestoreDatabaseName } from '../idbImportJournalSchema'

/** Durable transition coordinates only. This record never authenticates an
 * archive or substitutes for current semantic, proof or reference inspection. */
export interface Brc38IdbRestorePublication {
  readonly protocol: 'brc38-idb-profile-publication/v1'
  readonly state: 'PUBLISHED' | 'ACTIVATED'
  readonly databaseName: string
  readonly importId: string
  readonly previewId: string
  readonly bindingSha256: string
  readonly archiveSha256: string
  readonly identityKey: string
  readonly chain: 'main' | 'test'
  readonly targetStorageIdentityKey: string
  readonly epoch: string
  readonly publishedRevision: number
  readonly publishedAt: number
  readonly activatedRevision?: number
  readonly activatedAt?: number
}
export function readBrc38IdbRestorePublication(selected: unknown): Readonly<Brc38IdbRestorePublication> {
  if (typeof selected !== 'string' || selected.length > 4096) invalid()
  const value = JSON.parse(selected) as Brc38IdbRestorePublication
  if (
    value === null ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    boundedJson(value) !== selected ||
    value.protocol !== 'brc38-idb-profile-publication/v1' ||
    !['PUBLISHED', 'ACTIVATED'].includes(value.state) ||
    !isIdbRestoreDatabaseName(value.databaseName) ||
    !isUuid(value.importId) ||
    !isUuid(value.previewId) ||
    value.importId === value.previewId ||
    !isSha(value.bindingSha256) ||
    !isSha(value.archiveSha256) ||
    typeof value.epoch !== 'string' ||
    !/^[0-9a-f]{32}$/.test(value.epoch) ||
    !['main', 'test'].includes(value.chain) ||
    !value.databaseName.startsWith(`wallet-toolbox-${value.chain}net-restore-v1-`)
  )
    invalid()
  for (const text of [value.identityKey, value.targetStorageIdentityKey])
    if (typeof text !== 'string' || text.length < 1 || new TextEncoder().encode(text).byteLength > 256) invalid()
  integer(value.publishedRevision, 1, Number.MAX_SAFE_INTEGER)
  integer(value.publishedAt, 1, Number.MAX_SAFE_INTEGER)
  const names = [
    'protocol',
    'state',
    'databaseName',
    'importId',
    'previewId',
    'bindingSha256',
    'archiveSha256',
    'identityKey',
    'chain',
    'targetStorageIdentityKey',
    'epoch',
    'publishedRevision',
    'publishedAt'
  ]
  if (value.state === 'ACTIVATED') {
    names.push('activatedRevision', 'activatedAt')
    integer(value.activatedRevision!, 1, Number.MAX_SAFE_INTEGER)
    integer(value.activatedAt!, value.publishedAt, Number.MAX_SAFE_INTEGER)
    if (value.activatedRevision !== value.publishedRevision + 1) invalid()
  }
  if (Object.keys(value).length !== names.length || Object.keys(value).some(name => !names.includes(name))) invalid()
  return Object.freeze({ ...value })
}
