import { Db, Collection } from 'mongodb'

/**
 * Represents a banned record in the persistent ban list.
 * Bans survive server restarts, GASP re-syncs, and janitor runs.
 */
export interface BannedRecord {
  type: 'domain' | 'outpoint'
  /** For domain bans: the domain URL. For outpoint bans: "txid.outputIndex" */
  value: string
  /** For outpoint bans, the associated domain (for reference) */
  domain?: string
  /** Human-readable reason for the ban */
  reason?: string
  /** When the ban was created */
  bannedAt: Date
  /** Identity key of the admin who created the ban */
  bannedBy?: string
}

/**
 * BanService provides a persistent ban list stored in MongoDB.
 *
 * When the Janitor or an admin removes a SHIP/SLAP token, the associated
 * domain or outpoint can be added to the ban list. The BanAwareLookupWrapper
 * checks this list before admitting new outputs, preventing GASP from
 * re-syncing previously removed stale tokens.
 */
export class BanService {
  private readonly bans: Collection<BannedRecord>

  constructor (db: Db) {
    this.bans = db.collection<BannedRecord>('bannedRecords')
  }

  /**
   * Sanitizes a value for use in MongoDB queries, preventing NoSQL injection.
   * Ensures the value is a plain string and rejects objects/arrays that could
   * contain MongoDB operators like $ne, $gt, etc.
   */
  private sanitize (value: unknown): string {
    if (typeof value !== 'string') {
      throw new TypeError('Invalid input: expected a string value')
    }
    return value
  }

  /**
   * Creates indexes for efficient ban lookups.
   */
  async ensureIndexes (): Promise<void> {
    await this.bans.createIndex({ type: 1, value: 1 }, { unique: true })
    await this.bans.createIndex({ bannedAt: -1 })
  }

  /**
   * Bans a domain, preventing any SHIP/SLAP tokens referencing it from being stored.
   */
  async banDomain (domain: string, reason?: string, bannedBy?: string): Promise<void> {
    const safeDomain = this.sanitize(domain)
    await this.bans.updateOne(
      { type: 'domain', value: safeDomain },
      {
        $set: {
          type: 'domain',
          value: safeDomain,
          reason: reason ?? 'Manually banned',
          bannedAt: new Date(),
          bannedBy
        }
      },
      { upsert: true }
    )
  }

  /**
   * Removes a domain ban.
   */
  async unbanDomain (domain: string): Promise<void> {
    await this.bans.deleteOne({ type: 'domain', value: this.sanitize(domain) })
  }

  /**
   * Checks if a domain is banned.
   */
  async isDomainBanned (domain: string): Promise<boolean> {
    const record = await this.bans.findOne({ type: 'domain', value: this.sanitize(domain) })
    return record !== null
  }

  /**
   * Bans a specific outpoint (txid.outputIndex), preventing it from being re-admitted.
   */
  async banOutpoint (txid: string, outputIndex: number, reason?: string, domain?: string, bannedBy?: string): Promise<void> {
    const value = `${this.sanitize(txid)}.${Number(outputIndex)}`
    await this.bans.updateOne(
      { type: 'outpoint', value },
      {
        $set: {
          type: 'outpoint',
          value,
          domain: domain != null ? this.sanitize(domain) : undefined,
          reason: reason ?? 'Manually banned',
          bannedAt: new Date(),
          bannedBy
        }
      },
      { upsert: true }
    )
  }

  /**
   * Removes an outpoint ban.
   */
  async unbanOutpoint (txid: string, outputIndex: number): Promise<void> {
    const value = `${this.sanitize(txid)}.${Number(outputIndex)}`
    await this.bans.deleteOne({ type: 'outpoint', value })
  }

  /**
   * Checks if a specific outpoint is banned.
   */
  async isOutpointBanned (txid: string, outputIndex: number): Promise<boolean> {
    const value = `${this.sanitize(txid)}.${Number(outputIndex)}`
    const record = await this.bans.findOne({ type: 'outpoint', value })
    return record !== null
  }

  /**
   * Lists all bans, optionally filtered by type.
   */
  async listBans (type?: 'domain' | 'outpoint'): Promise<BannedRecord[]> {
    const query = typeof type === 'string' ? { type } : {}
    return await this.bans.find(query).sort({ bannedAt: -1 }).toArray()
  }

  /**
   * Removes a ban by type and value.
   */
  async removeBan (type: 'domain' | 'outpoint', value: string): Promise<void> {
    await this.bans.deleteOne({ type: this.sanitize(type) as 'domain' | 'outpoint', value: this.sanitize(value) })
  }

  /**
   * Returns ban statistics.
   */
  async getStats (): Promise<{ domainBans: number, outpointBans: number, totalBans: number }> {
    const [domainBans, outpointBans] = await Promise.all([
      this.bans.countDocuments({ type: 'domain' }),
      this.bans.countDocuments({ type: 'outpoint' })
    ])
    return { domainBans, outpointBans, totalBans: domainBans + outpointBans }
  }
}
