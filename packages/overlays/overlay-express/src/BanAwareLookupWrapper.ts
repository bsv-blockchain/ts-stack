import {
  LookupService,
  LookupFormula,
  AdmissionMode,
  SpendNotificationMode,
  OutputAdmittedByTopic,
  OutputSpent,
  LookupServiceMetaData
} from '@bsv/overlay'
import { PushDrop, Utils, LookupQuestion } from '@bsv/sdk'
import { BanService } from './BanService.js'

/**
 * Wraps a SHIP or SLAP LookupService to intercept outputAdmittedByTopic calls
 * and block outputs whose domain or outpoint appears in the persistent ban list.
 *
 * This prevents GASP from re-syncing stale or banned tokens that were previously
 * removed by the Janitor or an admin.
 */
export class BanAwareLookupWrapper implements LookupService {
  readonly admissionMode: AdmissionMode
  readonly spendNotificationMode: SpendNotificationMode

  constructor (
    private readonly wrapped: LookupService,
    private readonly banService: BanService,
    private readonly protocol: 'SHIP' | 'SLAP',
    private readonly logger: typeof console = console
  ) {
    this.admissionMode = wrapped.admissionMode
    this.spendNotificationMode = wrapped.spendNotificationMode
  }

  /**
   * Intercepts admission to check the ban list before delegating to the wrapped service.
   * If the output's domain or outpoint is banned, the admission is silently blocked.
   */
  async outputAdmittedByTopic (payload: OutputAdmittedByTopic): Promise<void> {
    if (payload.mode === 'locking-script') {
      const { txid, outputIndex, lockingScript } = payload

      // Check if the specific outpoint is banned
      if (await this.banService.isOutpointBanned(txid, outputIndex)) {
        this.logger.log(`[BAN] Blocked banned outpoint ${txid}.${outputIndex} from ${this.protocol}`)
        return
      }

      // Try to parse the domain from PushDrop fields and check domain ban
      try {
        const result = PushDrop.decode(lockingScript)
        if (result.fields.length >= 3) {
          const domain = Utils.toUTF8(result.fields[2])
          if (await this.banService.isDomainBanned(domain)) {
            this.logger.log(`[BAN] Blocked banned domain ${domain} from ${this.protocol} (${txid}.${outputIndex})`)
            return
          }
        }
      } catch {
        // If we can't parse PushDrop fields, let it through to the wrapped service
        // which will apply its own validation
      }
    }

    // Delegate to the wrapped service
    return await this.wrapped.outputAdmittedByTopic(payload)
  }

  async outputSpent (payload: OutputSpent): Promise<void> {
    if (typeof this.wrapped.outputSpent === 'function') {
      return await this.wrapped.outputSpent(payload)
    }
  }

  async outputNoLongerRetainedInHistory (txid: string, outputIndex: number, topic: string): Promise<void> {
    if (typeof this.wrapped.outputNoLongerRetainedInHistory === 'function') {
      return await this.wrapped.outputNoLongerRetainedInHistory(txid, outputIndex, topic)
    }
  }

  async outputEvicted (txid: string, outputIndex: number): Promise<void> {
    return await this.wrapped.outputEvicted(txid, outputIndex)
  }

  async lookup (question: LookupQuestion): Promise<LookupFormula> {
    return await this.wrapped.lookup(question)
  }

  async getDocumentation (): Promise<string> {
    return await this.wrapped.getDocumentation()
  }

  async getMetaData (): Promise<LookupServiceMetaData> {
    return await this.wrapped.getMetaData()
  }
}
