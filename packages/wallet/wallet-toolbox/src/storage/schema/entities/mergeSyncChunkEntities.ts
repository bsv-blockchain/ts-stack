import type { SyncChunk, TrxToken } from '../../../sdk/WalletStorage.interfaces'
import { maxDate } from '../../../utility/utilityHelpers'
import type { EntityStorage, SyncMap } from './EntityBase'
import { EntityCertificate } from './EntityCertificate'
import { EntityCertificateField } from './EntityCertificateField'
import { EntityCommission } from './EntityCommission'
import { EntityOutput } from './EntityOutput'
import { EntityOutputBasket } from './EntityOutputBasket'
import { EntityOutputTag } from './EntityOutputTag'
import { EntityOutputTagMap } from './EntityOutputTagMap'
import { EntityProvenTx } from './EntityProvenTx'
import { EntityProvenTxReq } from './EntityProvenTxReq'
import { EntityTransaction } from './EntityTransaction'
import { EntityTxLabel } from './EntityTxLabel'
import { EntityTxLabelMap } from './EntityTxLabelMap'
import { EntityUser } from './EntityUser'
import { MergeEntity } from './MergeEntity'

/** Merge a bounded set of rows using a caller-owned ID map and transaction. No checkpoint is persisted here. */
export async function mergeSyncChunkEntities(
  writer: EntityStorage,
  userId: number,
  since: Date | undefined,
  chunk: SyncChunk,
  syncMap: SyncMap,
  trx?: TrxToken
): Promise<{ done: boolean; maxUpdated_at: Date | undefined; updates: number; inserts: number }> {
  const mes = [
    new MergeEntity(chunk.provenTxs, EntityProvenTx.mergeFind, syncMap.provenTx),
    new MergeEntity(chunk.outputBaskets, EntityOutputBasket.mergeFind, syncMap.outputBasket),
    new MergeEntity(chunk.outputTags, EntityOutputTag.mergeFind, syncMap.outputTag),
    new MergeEntity(chunk.txLabels, EntityTxLabel.mergeFind, syncMap.txLabel),
    new MergeEntity(chunk.transactions, EntityTransaction.mergeFind, syncMap.transaction),
    new MergeEntity(chunk.outputs, EntityOutput.mergeFind, syncMap.output),
    new MergeEntity(chunk.txLabelMaps, EntityTxLabelMap.mergeFind, syncMap.txLabelMap),
    new MergeEntity(chunk.outputTagMaps, EntityOutputTagMap.mergeFind, syncMap.outputTagMap),
    new MergeEntity(chunk.certificates, EntityCertificate.mergeFind, syncMap.certificate),
    new MergeEntity(chunk.certificateFields, EntityCertificateField.mergeFind, syncMap.certificateField),
    new MergeEntity(chunk.commissions, EntityCommission.mergeFind, syncMap.commission),
    new MergeEntity(chunk.provenTxReqs, EntityProvenTxReq.mergeFind, syncMap.provenTxReq)
  ]

  let updates = 0
  let inserts = 0
  let maxUpdated_at: Date | undefined
  let done = true

  // Merge User
  if (chunk.user != null) {
    const ei = chunk.user
    const { found, eo } = await EntityUser.mergeFind(writer, userId, ei, trx)
    if (found) {
      if (await eo.mergeExisting(writer, since, ei, undefined, trx)) {
        maxUpdated_at = maxDate(maxUpdated_at, ei.updated_at)
        updates++
      }
    }
  }

  // Merge everything else...
  for (const me of mes) {
    const r = await me.merge(since, writer, userId, syncMap, trx)
    // The counts become the offsets for the next chunk.
    me.esm.count += me.stateArray?.length || 0
    updates += r.updates
    inserts += r.inserts
    maxUpdated_at = maxDate(maxUpdated_at, me.esm.maxUpdated_at)
    // If any entity type either did not report results or if there were at least one, then we aren't done.
    if (me.stateArray === undefined || me.stateArray.length > 0) done = false
  }

  if (done) for (const me of mes) me.esm.count = 0
  return { done, maxUpdated_at, updates, inserts }
}
