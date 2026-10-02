// The registry topic manager on BRC-162 (spec §5.4): the identity registration chain is its own
// authority deployment. It runs layers A to C over a transaction (registry kinds only, no value
// outputs), then journals the verified owner of every token output it is about to admit, exactly
// as the Mandala topic does. There are no issuer controls (layer D): the registry has no value, no
// access mode, and sanctions do not apply to registry actions. Every refusal is a typed
// MandalaReject; any other error propagates unchanged for the engine to log.
import { Transaction } from '@bsv/sdk'
import type { AdmittanceInstructions, WalletInterface } from '@bsv/sdk'
import type { TopicAdmittanceContext, TopicManager } from '@bsv/overlay'
import { buildLedger, classifyAdmittedInputs, classifyOutputs } from '../brc162/ledger.js'
import type { Brc162Output } from '../brc162/ledger.js'
import {
  ascendingIndices,
  journalOwners,
  logOwnerRepair,
  trustedSet
} from '../mandala/MandalaTopicManager.js'
import type { MandalaStateStore } from '../mandala/MandalaStorageManager.js'
import { checkAuthority } from '../mandala/authority.js'
import {
  requireValidTokenOutputs,
  resolveInputOwners,
  verifyOutputOwners
} from '../mandala/ownership.js'
import { Reasons } from '../mandala/reject.js'
import { decodeEnvelope } from '../mandala/types.js'
import type { EngineOutputReader } from '../mandala/types.js'
import docs from './RegistryDocs.md.js'
import type { RegistryStorage } from './RegistryStorage.js'

export const REGISTRY_TOPIC = 'tm_mandala_registry'

export interface RegistryTopicManagerDeps {
  verifierWallet: WalletInterface
  /** Compressed public keys, lowercase hex: non-empty, canonical and unique. */
  trustedIssuers: readonly string[]
  /** The same state store, and so the same journal collections, as the Mandala topic manager. */
  stateStore: MandalaStateStore
  engineOutputs: EngineOutputReader
  registry: RegistryStorage
  /**
   * The §4.2a rule 3 repair log: called with the outpoint of every owner-index row repaired inline
   * (`inserted` false: an existing row was corrected). Defaults to `console.warn`.
   */
  onOwnerRepair?: (outpoint: string, inserted: boolean) => void
}

export class RegistryTopicManager implements TopicManager {
  private readonly deps: RegistryTopicManagerDeps
  private readonly trusted: ReadonlySet<string>
  private readonly onRepair: (outpoint: string, inserted: boolean) => void

  constructor(deps: RegistryTopicManagerDeps) {
    this.trusted = trustedSet(deps.trustedIssuers, 'RegistryTopicManager')
    this.onRepair = deps.onOwnerRepair ?? logOwnerRepair('RegistryTopicManager')
    this.deps = deps
  }

  async identifyAdmissibleOutputs(
    beef: number[],
    previousCoins: number[],
    offChainValues?: number[],
    _mode?: 'historical-tx' | 'current-tx' | 'historical-tx-no-spv',
    context?: TopicAdmittanceContext
  ): Promise<AdmittanceInstructions> {
    const tx = Transaction.fromBEEF(beef)
    const txid = tx.id('hex')
    const env = decodeEnvelope(offChainValues)
    const { verifierWallet, stateStore: store, engineOutputs: engine } = this.deps

    // layer A
    const { outputs, invalid } = classifyOutputs(tx)
    const inputs = classifyAdmittedInputs(tx, previousCoins)
    const ledger = buildLedger(txid, outputs, inputs)

    // layer B
    requireValidTokenOutputs(invalid, outputs)
    const owners = await verifyOutputOwners(outputs, env, verifierWallet)
    const inputOwners = await resolveInputOwners(inputs, tx, env, {
      store,
      engine,
      verifierWallet,
      topic: REGISTRY_TOPIC,
      onRepair: this.onRepair
    })

    // layer C, then the registry's own rule: the first trusted deploy wins
    await checkAuthority(txid, ledger, outputs, owners, inputOwners, env, {
      trustedIssuers: this.trusted,
      store,
      registry: true
    })
    await this.requireFirstRegistry(outputs)

    if (outputs.length > 0 && context?.dryRun !== true) {
      await journalOwners(store, REGISTRY_TOPIC, txid, owners)
    }
    return { outputsToAdmit: ascendingIndices(outputs), coinsToRetain: previousCoins }
  }

  /**
   * A deploy is refused once another token has been claimed as the registry. Only a deploy reads
   * the claim, and the claimed registry's own deploy (a replay) is not another token.
   */
  private async requireFirstRegistry(outputs: readonly Brc162Output[]): Promise<void> {
    const deploy = outputs.find(output => output.role === 'deploy')
    if (deploy === undefined) return
    const claimed = await this.claimedRegistry()
    if (claimed !== null && claimed !== deploy.tokenId) throw Reasons.registryExists()
  }

  // A read fault is an infra reject (retryable, never persisted), keeping the store's error as cause.
  private async claimedRegistry(): Promise<string | null> {
    try {
      return await this.deps.registry.registryTokenId()
    } catch (cause) {
      throw Reasons.storeUnavailable('the registry', cause)
    }
  }

  getDocumentation(): Promise<string> {
    return Promise.resolve(docs)
  }

  getMetaData(): Promise<{ name: string; shortDescription: string }> {
    return Promise.resolve({
      name: REGISTRY_TOPIC,
      shortDescription:
        'Mandala identity registry on BRC-162: a single authority chain that admits and revokes identities. No value outputs.'
    })
  }
}
