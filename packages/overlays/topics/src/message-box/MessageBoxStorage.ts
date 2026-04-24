import { LookupFormula } from '@bsv/overlay'
import { PubKeyHex } from '@bsv/sdk'
import { Collection, Db } from 'mongodb'

export interface MessageBoxQuery {
  identityKey: PubKeyHex
  host?: string
}

export class MessageBoxStorage {
  private readonly adsCollection: Collection

  constructor(db: Db) {
    this.adsCollection = db.collection('messagebox_advertisement')
  }

  async storeRecord(identityKey: string, host: string, txid: string, outputIndex: number): Promise<void> {
    await this.adsCollection.insertOne({ identityKey, host, txid, outputIndex, createdAt: new Date() })
  }

  async deleteRecord(txid: string, outputIndex: number): Promise<void> {
    await this.adsCollection.deleteOne({ txid, outputIndex })
  }

  async findAdvertisements(identityKey: string, host?: string): Promise<LookupFormula> {
    const filter: MessageBoxQuery = { identityKey }
    if (host !== undefined) filter.host = host
    const cursor = this.adsCollection.find(filter).project({ txid: 1, outputIndex: 1 }).sort({ createdAt: -1 })
    const results = await cursor.toArray()
    return results.map(doc => ({ txid: doc.txid, outputIndex: doc.outputIndex }))
  }

  async findAll(): Promise<LookupFormula> {
    const cursor = this.adsCollection.find({}).project({ txid: 1, outputIndex: 1 }).sort({ createdAt: -1 })
    const results = await cursor.toArray()
    return results.map(doc => ({ txid: doc.txid, outputIndex: doc.outputIndex }))
  }

  async findRecent(limit = 10): Promise<LookupFormula> {
    const cursor = this.adsCollection.find({}).project({ txid: 1, outputIndex: 1 }).sort({ createdAt: -1 }).limit(limit)
    const results = await cursor.toArray()
    return results.map(doc => ({ txid: doc.txid, outputIndex: doc.outputIndex }))
  }
}
