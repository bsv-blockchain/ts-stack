// The registry lookup service on BRC-162 (spec §5.4, §6.6). It claims the registry token on the
// first deploy it sees, folds each committed admitIdentity / revokeIdentity action of that token
// into `mandalaRegistry`, and keeps the registry's authority outputs in `mandalaAuthorities`.
// The registry itself is served by the overlay's routes, so `lookup` answers nothing.
//
// Membership is the security-relevant write, so it comes first; the authority row is an index the
// next spend can repair from the owner journal. Every write is first-write-wins, so a replayed
// notification, or a row an inline repair inserted first, changes nothing.
import { Transaction } from '@bsv/sdk'
import type {
  AdmissionMode,
  LookupFormula,
  LookupQuestion,
  LookupService,
  OutputAdmittedByTopic,
  OutputSpent,
  SpendNotificationMode
} from '@bsv/overlay'
import type { Db } from 'mongodb'
import { classifyOutputs } from '../brc162/ledger.js'
import type { Brc162Output } from '../brc162/ledger.js'
import { committedAction, journalAgrees } from '../mandala/MandalaLookupService.js'
import type { MandalaStorageManager } from '../mandala/MandalaStorageManager.js'
import { REGISTRY_KINDS } from '../mandala/details.js'
import { decodeEnvelope } from '../mandala/types.js'
import type { MandalaEnvelope } from '../mandala/types.js'
import docs from './RegistryDocs.md.js'
import type { RegistryStorage } from './RegistryStorage.js'
import { REGISTRY_TOPIC } from './RegistryTopicManager.js'

export const REGISTRY_LOOKUP = 'ls_mandala_registry'

export interface RegistryLookupDeps {
  registry: RegistryStorage
  storage: MandalaStorageManager
}

export class RegistryLookupService implements LookupService {
  readonly admissionMode: AdmissionMode = 'whole-tx'
  readonly spendNotificationMode: SpendNotificationMode = 'script'

  constructor(private readonly deps: RegistryLookupDeps) {}

  async outputAdmittedByTopic(payload: OutputAdmittedByTopic): Promise<void> {
    if (payload.mode !== 'whole-tx' || payload.topic !== REGISTRY_TOPIC) return
    const tx = Transaction.fromBEEF(payload.atomicBEEF)
    const output = classifyOutputs(tx).outputs.find(o => o.index === payload.outputIndex)
    // The topic admits no value output, so a value output here is not the registry's.
    if (output === undefined || output.role === 'value') return
    const txid = tx.id('hex')
    if (output.role === 'deploy') await this.deps.registry.claimRegistryTokenId(output.tokenId)
    await this.foldAction(txid, output, decodeEnvelope(payload.offChainValues))
    await this.indexAuthority(txid, output)
  }

  /**
   * Folds the committed action into the identity's row, but only for the claimed registry token.
   * The deploy's own claim can be lost to a store fault, so the first action of a chain claims it
   * again: the first claim wins, and a rival chain admitted before it moves no membership.
   */
  private async foldAction(
    txid: string,
    output: Brc162Output,
    env: MandalaEnvelope
  ): Promise<void> {
    const action = committedAction(output, env, REGISTRY_KINDS)
    if (action === undefined) return
    const { registry } = this.deps
    await registry.claimRegistryTokenId(output.tokenId)
    if ((await registry.registryTokenId()) !== output.tokenId) return
    const { kind, identityKey } = action.details
    // The schema (spec §3.3) requires identityKey for both registry kinds.
    if (identityKey === undefined) throw new Error(`registry action ${kind} has no identityKey`)
    const status = kind === 'admitIdentity' ? 'admitted' : 'revoked'
    await registry.apply(identityKey, status, { txid, outputIndex: output.index })
  }

  /** The authority row, owned by the journalled identity; with no agreeing journal it is left. */
  private async indexAuthority(txid: string, output: Brc162Output): Promise<void> {
    const { storage } = this.deps
    const journal = await storage.getOwnerJournal(txid, output.index, REGISTRY_TOPIC)
    if (journal === null || !journalAgrees(journal, output)) return
    await storage.storeAuthorityIfAbsent({
      txid,
      outputIndex: output.index,
      topic: REGISTRY_TOPIC,
      tokenId: output.tokenId,
      identityKey: journal.identityKey,
      createdAt: new Date()
    })
  }

  async outputSpent(payload: OutputSpent): Promise<void> {
    if (payload.topic !== REGISTRY_TOPIC) return
    await this.deps.storage.takeAuthority(payload.txid, payload.outputIndex)
  }

  /** The registry row of an evicted action is kept: nothing records what it replaced. */
  async outputEvicted(txid: string, outputIndex: number): Promise<void> {
    await this.deps.storage.takeAuthority(txid, outputIndex)
  }

  lookup(_question: LookupQuestion): Promise<LookupFormula> {
    return Promise.resolve([])
  }

  getDocumentation(): Promise<string> {
    return Promise.resolve(docs)
  }

  getMetaData(): Promise<{ name: string; shortDescription: string }> {
    return Promise.resolve({
      name: REGISTRY_LOOKUP,
      shortDescription:
        'Mandala identity registry index: folds admit and revoke actions into the membership cache and tracks the registry authority.'
    })
  }
}

export function createRegistryLookupService(
  registry: RegistryStorage,
  storage: MandalaStorageManager
): (db: Db) => RegistryLookupService {
  return () => new RegistryLookupService({ registry, storage })
}
