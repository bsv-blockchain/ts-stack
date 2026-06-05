import { TopicManager } from '@bsv/overlay'
import { AdmittanceInstructions, PushDrop, Transaction, Utils } from '@bsv/sdk'
import { BanService } from './BanService.js'

/**
 * Filters banned SHIP or SLAP advertisement outputs before the overlay engine
 * admits them into topic storage.
 */
export class BanAwareTopicManager implements TopicManager {
  constructor (
    private readonly wrapped: TopicManager,
    private readonly banService: BanService,
    private readonly protocol: 'SHIP' | 'SLAP',
    private readonly logger: typeof console = console
  ) {}

  async identifyAdmissibleOutputs (
    beef: number[],
    previousCoins: number[],
    offChainValues?: number[],
    mode?: 'historical-tx' | 'current-tx' | 'historical-tx-no-spv'
  ): Promise<AdmittanceInstructions> {
    const instructions = await this.wrapped.identifyAdmissibleOutputs(beef, previousCoins, offChainValues, mode)
    if (instructions.outputsToAdmit.length === 0) return instructions

    let tx: Transaction
    try {
      tx = Transaction.fromBEEF(beef)
    } catch {
      return instructions
    }

    const txid = tx.id('hex')
    const outputsToAdmit: number[] = []

    for (const outputIndex of instructions.outputsToAdmit) {
      if (await this.banService.isOutpointBanned(txid, outputIndex)) {
        this.logger.log(`[BAN] Blocked banned outpoint ${txid}.${outputIndex} from ${this.protocol} topic admittance`)
        continue
      }

      const output = tx.outputs[outputIndex]
      if (output === undefined) continue

      try {
        const result = PushDrop.decode(output.lockingScript)
        if (result.fields.length >= 3 && Utils.toUTF8(result.fields[0]) === this.protocol) {
          const domain = Utils.toUTF8(result.fields[2])
          if (await this.banService.isDomainBanned(domain)) {
            this.logger.log(`[BAN] Blocked banned domain ${domain} from ${this.protocol} topic admittance (${txid}.${outputIndex})`)
            continue
          }
        }
      } catch {
        // Non PushDrop outputs remain subject to the wrapped manager's decision.
      }

      outputsToAdmit.push(outputIndex)
    }

    return {
      ...instructions,
      outputsToAdmit
    }
  }

  async identifyNeededInputs (beef: number[], offChainValues?: number[]): Promise<Array<{ txid: string, outputIndex: number }>> {
    if (typeof this.wrapped.identifyNeededInputs === 'function') {
      return await this.wrapped.identifyNeededInputs(beef, offChainValues)
    }
    return []
  }

  async getDocumentation (): Promise<string> {
    return await this.wrapped.getDocumentation()
  }

  async getMetaData (): Promise<{
    name: string
    shortDescription: string
    iconURL?: string
    version?: string
    informationURL?: string
  }> {
    return await this.wrapped.getMetaData()
  }
}
