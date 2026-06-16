import * as DiscoveryServices from '@bsv/overlay-discovery-services'
import { BanService } from './BanService.js'

type SHIPStorage = InstanceType<typeof DiscoveryServices.SHIPStorage>
type SLAPStorage = InstanceType<typeof DiscoveryServices.SLAPStorage>

/**
 * Prevents banned SHIP records from being written to discovery storage.
 */
export class BanAwareSHIPStorage {
  constructor (
    private readonly wrapped: SHIPStorage,
    private readonly banService: BanService,
    private readonly logger: typeof console = console
  ) {}

  async ensureIndexes (): Promise<void> {
    return await this.wrapped.ensureIndexes()
  }

  async hasDuplicateRecord (identityKey: string, domain: string, topic: string): Promise<boolean> {
    return await this.wrapped.hasDuplicateRecord(identityKey, domain, topic)
  }

  async storeSHIPRecord (txid: string, outputIndex: number, identityKey: string, domain: string, topic: string): Promise<void> {
    if (await this.banService.isOutpointBanned(txid, outputIndex)) {
      this.logger.log(`[BAN] Blocked banned outpoint ${txid}.${outputIndex} from SHIP storage`)
      return
    }
    if (await this.banService.isDomainBanned(domain)) {
      this.logger.log(`[BAN] Blocked banned domain ${domain} from SHIP storage (${txid}.${outputIndex})`)
      return
    }
    return await this.wrapped.storeSHIPRecord(txid, outputIndex, identityKey, domain, topic)
  }

  async deleteSHIPRecord (txid: string, outputIndex: number): Promise<void> {
    return await this.wrapped.deleteSHIPRecord(txid, outputIndex)
  }

  async findRecord (...args: Parameters<SHIPStorage['findRecord']>): ReturnType<SHIPStorage['findRecord']> {
    return await this.wrapped.findRecord(...args)
  }

  async findAll (...args: Parameters<SHIPStorage['findAll']>): ReturnType<SHIPStorage['findAll']> {
    return await this.wrapped.findAll(...args)
  }
}

/**
 * Prevents banned SLAP records from being written to discovery storage.
 */
export class BanAwareSLAPStorage {
  constructor (
    private readonly wrapped: SLAPStorage,
    private readonly banService: BanService,
    private readonly logger: typeof console = console
  ) {}

  async ensureIndexes (): Promise<void> {
    return await this.wrapped.ensureIndexes()
  }

  async hasDuplicateRecord (identityKey: string, domain: string, service: string): Promise<boolean> {
    return await this.wrapped.hasDuplicateRecord(identityKey, domain, service)
  }

  async storeSLAPRecord (txid: string, outputIndex: number, identityKey: string, domain: string, service: string): Promise<void> {
    if (await this.banService.isOutpointBanned(txid, outputIndex)) {
      this.logger.log(`[BAN] Blocked banned outpoint ${txid}.${outputIndex} from SLAP storage`)
      return
    }
    if (await this.banService.isDomainBanned(domain)) {
      this.logger.log(`[BAN] Blocked banned domain ${domain} from SLAP storage (${txid}.${outputIndex})`)
      return
    }
    return await this.wrapped.storeSLAPRecord(txid, outputIndex, identityKey, domain, service)
  }

  async deleteSLAPRecord (txid: string, outputIndex: number): Promise<void> {
    return await this.wrapped.deleteSLAPRecord(txid, outputIndex)
  }

  async findRecord (...args: Parameters<SLAPStorage['findRecord']>): ReturnType<SLAPStorage['findRecord']> {
    return await this.wrapped.findRecord(...args)
  }

  async findAll (...args: Parameters<SLAPStorage['findAll']>): ReturnType<SLAPStorage['findAll']> {
    return await this.wrapped.findAll(...args)
  }
}
