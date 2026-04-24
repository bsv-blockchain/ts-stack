import { AdmissionMode, LookupService, OutputAdmittedByTopic, OutputSpent, SpendNotificationMode } from '@bsv/overlay'
import { PushDrop, Utils, StorageUtils } from '@bsv/sdk'
import { UHRPRecord, UTXOReference } from './types'
import { Db, Collection } from 'mongodb'
import uhrpLookupDocs from './UHRPLookupDocs.md.js'

/**
 * Implements a Lookup Service for the Universal Hash Resolution Protocol
 */
class UHRPLookupService implements LookupService {
  readonly admissionMode: AdmissionMode = 'locking-script'
  readonly spendNotificationMode: SpendNotificationMode = 'none'
  records: Collection<UHRPRecord>

  constructor(db: Db) {
    this.records = db.collection<UHRPRecord>('uhrp')
  }

  async getDocumentation(): Promise<string> {
    return uhrpLookupDocs
  }

  async getMetaData(): Promise<{ name: string; shortDescription: string; iconURL?: string; version?: string; informationURL?: string }> {
    return {
      name: 'UHRP Lookup Service',
      shortDescription: 'Lookup Service for User file hosting commitment tokens'
    }
  }

  async outputAdmittedByTopic(payload: OutputAdmittedByTopic) {
    if (payload.mode !== 'locking-script') throw new Error('Invalid payload')
    const { topic, txid, outputIndex, lockingScript } = payload
    if (topic !== 'tm_uhrp') return
    // Decode the UHRP fields from the Bitcoin outputScript
    const result = PushDrop.decode(lockingScript)

    // UHRP advertisement Fields to store (from the UHRP protocol's PushDrop field order)
    const hostIdentityKey = Utils.toHex(result.fields[0])
    const uhrpUrl = StorageUtils.getURLForHash(result.fields[1])
    const hostedFileLocation = Utils.toUTF8(result.fields[2])
    const expiryTime = new Utils.Reader(result.fields[3]).readVarIntNum()
    const fileSize = new Utils.Reader(result.fields[4]).readVarIntNum()

    // Store UHRP fields in db
    await this.records.insertOne({
      uhrpUrl,
      txid,
      outputIndex,
      hostIdentityKey,
      hostedFileLocation,
      expiryTime,
      fileSize
    })
  }

  async outputSpent(payload: OutputSpent) {
    if (payload.mode !== 'none') throw new Error('Invalid payload')
    const { topic, txid, outputIndex } = payload
    if (topic !== 'tm_uhrp') return
    await this.records.deleteOne({ txid, outputIndex })
  }

  async outputEvicted(txid: string, outputIndex: number) {
    await this.records.deleteOne({ txid, outputIndex })
  }

  async lookup({ query }: any): Promise<UTXOReference[]> {
    // Validate Query
    if (typeof query !== 'object') {
      throw new Error('Lookup must include a valid query!')
    }
    if (query.outpoint) {
      const [txid, outputIndex] = (query.outpoint as string).split('.')
      const result = await this.records.findOne({ txid, outputIndex: Number(outputIndex) })
      if (!result) return []
      return [{ txid: result.txid, outputIndex: result.outputIndex }]
    }
    if (!query.uhrpUrl && !query.expiryTime && !query.hostIdentityKey) {
      throw new Error('Lookup must specify either outpoint, or at least one of (uhrpUrl, expiryTime, hostIdentityKey)')
    }
    const result = await this.records.find(query).toArray()
    return result.map(x => ({
      txid: x.txid,
      outputIndex: x.outputIndex
    }))
  }
}

export default (db: Db) => new UHRPLookupService(db);
