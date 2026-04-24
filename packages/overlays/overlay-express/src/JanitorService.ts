import { Db } from 'mongodb'
import chalk from 'chalk'
import { BanService } from './BanService.js'

/**
 * Configuration for the Janitor Service
 */
export interface JanitorConfig {
  mongoDb: Db
  logger?: typeof console
  requestTimeoutMs?: number
  hostDownRevokeScore?: number
  /** Optional BanService for persisting bans when hosts are removed */
  banService?: BanService
  /** Whether to auto-ban domains when they exceed the down threshold (default: true) */
  autoBanOnRemoval?: boolean
}

/**
 * Health status of a single record
 */
export interface HostHealthResult {
  txid: string
  outputIndex: number
  domain: string
  topic?: string
  service?: string
  identityKey?: string
  createdAt?: Date
  healthy: boolean
  downCount: number
  responseTimeMs?: number
  statusCode?: number
  error?: string
}

/**
 * Summary report from a janitor run
 */
export interface JanitorReport {
  startedAt: Date
  completedAt: Date
  durationMs: number
  shipResults: HostHealthResult[]
  slapResults: HostHealthResult[]
  summary: {
    totalChecked: number
    healthy: number
    unhealthy: number
    removed: number
    banned: number
  }
}

/**
 * JanitorService runs health checks on SHIP and SLAP outputs.
 * It validates domain names and checks /health endpoints to ensure services are operational.
 *
 * When a service is down, it increments a "down" counter. When healthy, it decrements.
 * If the down counter reaches hostDownRevokeScore, the output is deleted and optionally
 * the domain is added to the persistent ban list to prevent GASP re-sync.
 */
export class JanitorService {
  private readonly mongoDb: Db
  private readonly logger: typeof console
  private readonly requestTimeoutMs: number
  private readonly hostDownRevokeScore: number
  private readonly banService?: BanService
  private readonly autoBanOnRemoval: boolean

  constructor (config: JanitorConfig) {
    this.mongoDb = config.mongoDb
    this.logger = config.logger ?? console
    this.requestTimeoutMs = config.requestTimeoutMs ?? 10000
    this.hostDownRevokeScore = config.hostDownRevokeScore ?? 3
    this.banService = config.banService
    this.autoBanOnRemoval = config.autoBanOnRemoval ?? true
  }

  /**
   * Runs a full pass of health checks on all SHIP and SLAP outputs.
   * Returns a detailed report of the results.
   */
  async run (): Promise<JanitorReport> {
    const startedAt = new Date()
    this.logger.log(chalk.blue('Running janitor health checks...'))

    let shipResults: HostHealthResult[] = []
    let slapResults: HostHealthResult[] = []
    let removed = 0
    let banned = 0

    try {
      const shipCheckResult = await this.checkTopicOutputs('shipRecords', 'topic')
      shipResults = shipCheckResult.results
      removed += shipCheckResult.removed
      banned += shipCheckResult.banned

      const slapCheckResult = await this.checkTopicOutputs('slapRecords', 'service')
      slapResults = slapCheckResult.results
      removed += slapCheckResult.removed
      banned += slapCheckResult.banned

      this.logger.log(chalk.green('Janitor health checks completed'))
    } catch (error) {
      this.logger.error(chalk.red('Error during health checks:'), error)
      throw error
    }

    const completedAt = new Date()
    const allResults = [...shipResults, ...slapResults]
    return {
      startedAt,
      completedAt,
      durationMs: completedAt.getTime() - startedAt.getTime(),
      shipResults,
      slapResults,
      summary: {
        totalChecked: allResults.length,
        healthy: allResults.filter(r => r.healthy).length,
        unhealthy: allResults.filter(r => !r.healthy).length,
        removed,
        banned
      }
    }
  }

  /**
   * Checks a single URL's health endpoint. Used by the admin dashboard for on-demand checks.
   */
  async checkHost (url: string): Promise<{ healthy: boolean, responseTimeMs: number, statusCode?: number, error?: string }> {
    const startTime = Date.now()

    if (!this.isValidDomain(url)) {
      return {
        healthy: false,
        responseTimeMs: Date.now() - startTime,
        error: 'Invalid domain'
      }
    }

    try {
      const fullURL = url.startsWith('http') ? url : `https://${url}`
      const healthURL = new URL('/health', fullURL).toString()

      const controller = new AbortController()
      const timeout = setTimeout(() => controller.abort(), this.requestTimeoutMs)

      try {
        const response = await fetch(healthURL, {
          method: 'GET',
          signal: controller.signal,
          headers: { Accept: 'application/json' }
        })

        clearTimeout(timeout)
        const responseTimeMs = Date.now() - startTime

        if (!response.ok) {
          return { healthy: false, responseTimeMs, statusCode: response.status, error: `HTTP ${response.status}` }
        }

        const data = await response.json()
        const healthy = (data?.status === 'ok' && data?.ready !== false) || (data?.ready === true && data?.live !== false)
        return { healthy, responseTimeMs, statusCode: response.status, error: healthy ? undefined : 'Unexpected response' }
      } catch (error: any) {
        clearTimeout(timeout)
        const responseTimeMs = Date.now() - startTime
        if (error.name === 'AbortError') {
          return { healthy: false, responseTimeMs, error: 'Timeout' }
        }
        return { healthy: false, responseTimeMs, error: error.message ?? 'Connection failed' }
      }
    } catch (error: any) {
      return { healthy: false, responseTimeMs: Date.now() - startTime, error: error.message ?? 'Invalid URL' }
    }
  }

  /**
   * Gets health status for all records without modifying them.
   * Used by the dashboard to display current state.
   */
  async getHealthStatus (): Promise<{ ship: HostHealthResult[], slap: HostHealthResult[] }> {
    const shipCollection = this.mongoDb.collection('shipRecords')
    const slapCollection = this.mongoDb.collection('slapRecords')

    const [shipOutputs, slapOutputs] = await Promise.all([
      shipCollection.find({}).toArray(),
      slapCollection.find({}).toArray()
    ])

    const shipResults: HostHealthResult[] = shipOutputs.map(output => ({
      txid: output.txid as string,
      outputIndex: output.outputIndex as number,
      domain: this.extractURLFromOutput(output) ?? 'unknown',
      topic: output.topic as string,
      identityKey: output.identityKey as string,
      createdAt: output.createdAt as Date,
      healthy: true, // Will be updated if health check is run
      downCount: typeof output.down === 'number' ? output.down : 0
    }))

    const slapResults: HostHealthResult[] = slapOutputs.map(output => ({
      txid: output.txid as string,
      outputIndex: output.outputIndex as number,
      domain: this.extractURLFromOutput(output) ?? 'unknown',
      service: output.service as string,
      identityKey: output.identityKey as string,
      createdAt: output.createdAt as Date,
      healthy: true,
      downCount: typeof output.down === 'number' ? output.down : 0
    }))

    return { ship: shipResults, slap: slapResults }
  }

  /**
   * Checks all outputs for a specific collection and returns results.
   */
  private async checkTopicOutputs (
    collectionName: string,
    typeField: 'topic' | 'service'
  ): Promise<{ results: HostHealthResult[], removed: number, banned: number }> {
    const results: HostHealthResult[] = []
    let removed = 0
    let banned = 0

    try {
      const collection = this.mongoDb.collection(collectionName)
      const outputs = await collection.find({}).toArray()

      this.logger.log(chalk.cyan(`Checking ${outputs.length} ${collectionName} outputs...`))

      for (const output of outputs) {
        const result = await this.checkOutput(output, collection, typeField)
        results.push(result)
        if (result.error === 'REMOVED') {
          removed++
        }
      }

      // Count auto-bans that happened during this run
      if (this.banService !== undefined && this.autoBanOnRemoval) {
        banned = removed // Each removal triggers a ban
      }
    } catch (error) {
      this.logger.error(chalk.red(`Error checking ${collectionName} outputs:`), error)
    }

    return { results, removed, banned }
  }

  /**
   * Checks a single output for health and returns the result.
   */
  private async checkOutput (
    output: Record<string, any>,
    collection: any,
    typeField: 'topic' | 'service'
  ): Promise<HostHealthResult> {
    const domain = this.extractURLFromOutput(output) ?? 'unknown'
    const baseResult: HostHealthResult = {
      txid: output.txid as string,
      outputIndex: output.outputIndex as number,
      domain,
      identityKey: output.identityKey as string,
      createdAt: output.createdAt as Date,
      healthy: false,
      downCount: typeof output.down === 'number' ? output.down : 0
    }

    if (typeField === 'topic') {
      baseResult.topic = output.topic as string
    } else {
      baseResult.service = output.service as string
    }

    try {
      if (domain === 'unknown') {
        baseResult.error = 'No URL found'
        await this.handleUnhealthyOutput(output, collection, domain)
        return baseResult
      }

      if (!this.isValidDomain(domain)) {
        baseResult.error = 'Invalid domain'
        await this.handleUnhealthyOutput(output, collection, domain)
        return baseResult
      }

      const healthResult = await this.checkHost(domain)
      baseResult.healthy = healthResult.healthy
      baseResult.responseTimeMs = healthResult.responseTimeMs
      baseResult.statusCode = healthResult.statusCode
      baseResult.error = healthResult.error

      if (healthResult.healthy) {
        await this.handleHealthyOutput(output, collection)
        baseResult.downCount = Math.max(0, baseResult.downCount - 1)
      } else {
        const wasRemoved = await this.handleUnhealthyOutput(output, collection, domain)
        baseResult.downCount++
        if (wasRemoved) {
          baseResult.error = 'REMOVED'
        }
      }
    } catch (error: any) {
      baseResult.error = error.message ?? 'Check failed'
      await this.handleUnhealthyOutput(output, collection, domain).catch(() => {})
    }

    return baseResult
  }

  /**
   * Extracts URL from output record
   */
  private extractURLFromOutput (output: Record<string, any>): string | null {
    try {
      if (typeof output.domain === 'string') {
        return output.domain
      }
      if (typeof output.url === 'string') {
        return output.url
      }
      if (typeof output.serviceURL === 'string') {
        return output.serviceURL
      }
      if (Array.isArray(output.protocols) && output.protocols.length > 0) {
        const httpsProtocol = output.protocols.find((p: any) =>
          typeof p === 'string' && p.startsWith('https://')
        )
        if (httpsProtocol !== undefined) {
          return httpsProtocol
        }
      }
      return null
    } catch {
      return null
    }
  }

  /**
   * Validates if a string is a valid domain name
   */
  private isValidDomain (url: string): boolean {
    try {
      const parsedURL = new URL(url.startsWith('http') ? url : `https://${url}`)
      const hostname = parsedURL.hostname
      const domainRegex = /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9][a-z0-9-]{0,61}[a-z0-9]$/i
      const localhostRegex = /^localhost$/i
      const ipv4Regex = /^(\d{1,3}\.){3}\d{1,3}$/
      return domainRegex.test(hostname) || localhostRegex.test(hostname) || ipv4Regex.test(hostname)
    } catch {
      return false
    }
  }

  /**
   * Handles a healthy output by decrementing its down counter
   */
  private async handleHealthyOutput (output: Record<string, any>, collection: any): Promise<void> {
    try {
      const currentDown = typeof output.down === 'number' ? output.down : 0
      if (currentDown > 0) {
        await collection.updateOne(
          { _id: output._id },
          { $inc: { down: -1 } }
        )
      }
    } catch (error) {
      this.logger.error(chalk.red(`Error handling healthy output ${String(output.txid)}:${String(output.outputIndex)}:`), error)
    }
  }

  /**
   * Handles an unhealthy output by incrementing its down counter.
   * If the threshold is reached, deletes the record and optionally bans the domain.
   * Returns true if the record was removed.
   */
  private async handleUnhealthyOutput (output: Record<string, any>, collection: any, domain?: string): Promise<boolean> {
    try {
      const currentDown = typeof output.down === 'number' ? output.down : 0
      const newDown = currentDown + 1

      if (newDown >= this.hostDownRevokeScore) {
        this.logger.log(chalk.red(`Removing output ${String(output.txid)}:${String(output.outputIndex)} (down: ${newDown} >= ${this.hostDownRevokeScore})`))
        await collection.deleteOne({ _id: output._id })

        // Auto-ban the domain and outpoint to prevent GASP re-sync
        if (this.banService !== undefined && this.autoBanOnRemoval) {
          const txid = output.txid as string
          const outputIndex = output.outputIndex as number

          await this.banService.banOutpoint(
            txid,
            outputIndex,
            `Auto-banned by janitor: host down ${newDown} consecutive checks`,
            domain
          )

          if (typeof domain === 'string' && domain !== 'unknown') {
            await this.banService.banDomain(
              domain,
              `Auto-banned by janitor: host unresponsive after ${newDown} checks`
            )
          }
        }

        return true
      } else {
        await collection.updateOne(
          { _id: output._id },
          { $inc: { down: 1 } }
        )
        return false
      }
    } catch (error) {
      this.logger.error(chalk.red(`Error handling unhealthy output ${String(output.txid)}:${String(output.outputIndex)}:`), error)
      return false
    }
  }
}
