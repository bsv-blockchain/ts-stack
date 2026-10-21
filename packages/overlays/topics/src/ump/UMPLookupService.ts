import { toHex } from '@bsv/sdk/primitives/utils'
import {
  AdmissionMode,
  LookupQuestion,
  LookupService,
  OutputAdmittedByTopic,
  OutputSpent,
  SpendNotificationMode
} from '@bsv/overlay'
import { PushDrop } from '@bsv/sdk'
import { UMPRecord, UTXOReference } from './types.js'
import { Db, Collection } from 'mongodb'
import { MongoUMPIdentityStore, UMPIdentityReservationStore } from './UMPIdentityStore.js'
import {
  readString,
  requireHex,
  requireLookupQuery,
  requireOutpoint
} from '../shared/queryValidation.js'

export class UMPLookupService implements LookupService {
  readonly admissionMode: AdmissionMode = 'locking-script'
  readonly spendNotificationMode: SpendNotificationMode = 'none'
  records: Collection<UMPRecord>

  constructor(
    db: Db,
    readonly identityStore: UMPIdentityReservationStore = new MongoUMPIdentityStore(db)
  ) {
    this.records = db.collection<UMPRecord>('ump')
  }

  async outputAdmittedByTopic(payload: OutputAdmittedByTopic) {
    if (payload.mode !== 'locking-script') throw new Error('Invalid payload')
    const { txid, outputIndex, topic, lockingScript } = payload
    if (topic !== 'tm_users') return

    const result = PushDrop.decode(lockingScript)
    const protocolFields = result.fields

    const presentationHash = toHex(protocolFields[6])
    const recoveryHash = toHex(protocolFields[7])

    const hasV3AtIndex11 = protocolFields.length >= 12 && protocolFields[11]?.length === 1
    const hasV3AtIndex12 =
      !hasV3AtIndex11 && protocolFields.length >= 13 && protocolFields[12]?.length === 1
    const hasV3Candidate = hasV3AtIndex11 || hasV3AtIndex12
    const v3VersionIndex = hasV3AtIndex12 ? 12 : 11

    const record: UMPRecord = { txid, outputIndex, presentationHash, recoveryHash }

    if (hasV3Candidate) {
      record.umpVersion = protocolFields[v3VersionIndex][0]

      const kdfAlgIndex = v3VersionIndex + 1
      const kdfParamsIndex = v3VersionIndex + 2

      record.kdfAlgorithm = new TextDecoder().decode(new Uint8Array(protocolFields[kdfAlgIndex]))

      const kdfParamsJson = new TextDecoder().decode(new Uint8Array(protocolFields[kdfParamsIndex]))
      try {
        const kdfParams = JSON.parse(kdfParamsJson)
        record.kdfIterations = kdfParams.iterations
      } catch (e) {
        console.warn('Failed to parse kdfParams during storage:', e)
      }
    }

    await this.records.updateOne({ txid, outputIndex }, { $set: record }, { upsert: true })
    await this.identityStore.confirm(`${txid}.${outputIndex}`)
  }

  async outputSpent(payload: OutputSpent) {
    if (payload.mode !== 'none') throw new Error('Invalid payload')
    const { topic, txid, outputIndex } = payload
    if (topic !== 'tm_users') return
    await this.records.deleteOne({ txid, outputIndex })
    await this.identityStore.release(`${txid}.${outputIndex}`)
  }

  async outputEvicted(txid: string, outputIndex: number) {
    await this.records.deleteOne({ txid, outputIndex })
    await this.identityStore.release(`${txid}.${outputIndex}`)
  }

  async lookup(question: LookupQuestion): Promise<UTXOReference[]> {
    const query = requireLookupQuery(question, 'ls_users', [
      'presentationHash',
      'recoveryHash',
      'outpoint'
    ])
    const presentationHash = requireHex(
      readString(query, 'presentationHash', { maxBytes: 64 }),
      'presentationHash',
      32
    )
    const recoveryHash = requireHex(
      readString(query, 'recoveryHash', { maxBytes: 64 }),
      'recoveryHash',
      32
    )
    const outpoint = requireOutpoint(readString(query, 'outpoint', { maxBytes: 75 }))

    let filter: Record<string, any>
    if (presentationHash !== undefined) {
      filter = { presentationHash }
    } else if (recoveryHash !== undefined) {
      filter = { recoveryHash }
    } else if (outpoint !== undefined) {
      filter = outpoint
    } else {
      throw new Error('Query parameters must include presentationHash, recoveryHash, or outpoint!')
    }

    // Legacy ambiguous hashes can have more rows than the bounded response.
    // Prefer the most recently indexed candidates so the live lineage tip is
    // not permanently hidden behind the oldest 100 records.
    const docs = await this.records.find(filter).sort({ _id: -1 }).limit(100).toArray()
    // Token updates consume and retain their predecessors. Request the full
    // topical lineage even after confirmation; the Engine owns traversal bounds.
    return docs.map(doc => ({
      txid: doc.txid,
      outputIndex: doc.outputIndex,
      history: () => Promise.resolve(true)
    }))
  }

  async getDocumentation(): Promise<string> {
    return 'UMP Lookup Service: find wallet account descriptors by presentation hash, recovery hash, or outpoint, including their retained token-update lineage.'
  }

  async getMetaData(): Promise<{
    name: string
    shortDescription: string
    iconURL?: string
    version?: string
    informationURL?: string
  }> {
    return {
      name: 'UMP Lookup Service',
      shortDescription: 'Lookup Service for User Management Protocol tokens'
    }
  }
}

function create(db: Db, identityStore?: UMPIdentityReservationStore): UMPLookupService {
  return new UMPLookupService(db, identityStore)
}
export default create
