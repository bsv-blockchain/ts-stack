/**
 * MessageBox Storage Module
 * 
 * Provides a persistent database interface for storing and retrieving
 * MessageBox overlay advertisements using MongoDB.
 * 
 * This class supports saving advertisements received via SHIP broadcasts,
 * as well as querying and cleaning up those records.
 * 
 * @module MessageBoxStorage
 */

import { LookupFormula } from '@bsv/overlay'
import { PubKeyHex } from '@bsv/sdk'
import { Collection, Db } from 'mongodb'

export interface MessageBoxQuery {
  identityKey: PubKeyHex
  host?: string
}

/**
 * Handles all database operations for storing and querying MessageBox overlay advertisements.
 */
export class MessageBoxStorage {
  private readonly adsCollection: Collection

  /**
   * Creates a new MessageBoxStorage instance.
   *
   * @param db - An initialized MongoDB `Db` instance.
   */
  constructor(db: Db) {
    this.adsCollection = db.collection('messagebox_advertisement')
  }

  /**
   * Stores a new overlay advertisement record in the database.
   * 
   * @param identityKey - The identity key of the user advertising their MessageBox.
   * @param host - The host address of the MessageBox server.
   * @param txid - The transaction ID containing the advertisement.
   * @param outputIndex - The index of the output containing the ad in the transaction.
   */
  async storeRecord(
    identityKey: string,
    host: string,
    txid: string,
    outputIndex: number
  ): Promise<void> {
    await this.adsCollection.insertOne({
      identityKey,
      host,
      txid,
      outputIndex,
      createdAt: new Date()
    })
  }

  /**
   * Deletes an overlay advertisement by transaction ID and output index.
   * 
   * @param txid - The transaction ID of the ad.
   * @param outputIndex - The index of the ad output to delete.
   */
  async deleteRecord(txid: string, outputIndex: number): Promise<void> {
    await this.adsCollection.deleteOne({ txid, outputIndex })
  }

  /**
  * Finds all known lookup records for a given identity key, and optionally a host,
  * ordered by recency.
  *
  * @param identityKey - The identity key to look up.
  * @param host - The host to filter by (optional).
  * @returns An array of LookupFormula objects ordered by createdAt desc.
  */
  async findAdvertisements(identityKey: string, host?: string): Promise<LookupFormula> {
    const filter: MessageBoxQuery = { identityKey }
    if (host !== undefined) {
      filter.host = host
    }

    const cursor = this.adsCollection
      .find(filter)
      .project({ txid: 1, outputIndex: 1 })
      .sort({ createdAt: -1 });

    const results = await cursor.toArray()
    return results.map(doc => ({
      txid: doc.txid,
      outputIndex: doc.outputIndex
    }))
  }

  /**
   * Lists all stored advertisements in the database.
   * 
   * @returns An array of LookupFormula objects ordered by createdAt desc.
   */
  async findAll(): Promise<LookupFormula> {
    const cursor = this.adsCollection
      .find({})
      .project({ txid: 1, outputIndex: 1 })
      .sort({ createdAt: -1 })

    const results = await cursor.toArray()
    return results.map(doc => ({
      txid: doc.txid,
      outputIndex: doc.outputIndex
    }))
  }

  /**
   * Returns a limited number of the most recent overlay advertisements.
   * 
   * @param limit - Maximum number of records to return (default: 10).
   * @returns An array of LookupFormula objects ordered by createdAt desc.
   */
  async findRecent(limit = 10): Promise<LookupFormula> {
    const cursor = this.adsCollection
      .find({})
      .project({ txid: 1, outputIndex: 1 })
      .sort({ createdAt: -1 })
      .limit(limit)

    const results = await cursor.toArray()
    return results.map(doc => ({
      txid: doc.txid,
      outputIndex: doc.outputIndex
    }))
  }
}

