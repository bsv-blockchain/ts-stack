// The Mandala topic manager on BRC-162 (spec §4, §4.2a). It runs layers A to D
// over a transaction, first refusal wins, and then journals the verified owner
// of every token output it is about to admit, before it returns admittance and
// so before the engine can broadcast. Every refusal is a typed MandalaReject;
// any other error (an unreadable BEEF, a bug) propagates unchanged for the
// engine to log.
import { PublicKey, Transaction } from '@bsv/sdk'
import type { AdmittanceInstructions, WalletInterface } from '@bsv/sdk'
import type { TopicAdmittanceContext, TopicManager } from '@bsv/overlay'
import { buildLedger, classifyAdmittedInputs, classifyOutputs } from '../brc162/ledger.js'
import type { Brc162Output } from '../brc162/ledger.js'
import type { MandalaStateStore } from './MandalaStorageManager.js'
import docs from './MandalaTopicDocs.md.js'
import { checkAuthority } from './authority.js'
import { checkControls } from './controls.js'
import { requireValidTokenOutputs, resolveInputOwners, verifyOutputOwners } from './ownership.js'
import type { VerifiedOwner } from './ownership.js'
import { MandalaReject, Reasons } from './reject.js'
import { decodeEnvelope } from './types.js'
import type {
  EngineOutputReader,
  MandalaOwnerRecord,
  MembershipProvider,
  ScreeningProvider
} from './types.js'

export const MANDALA_TOPIC = 'tm_mandala'

export interface MandalaTopicManagerDeps {
  verifierWallet: WalletInterface
  /** Compressed public keys, lowercase hex: non-empty, canonical and unique. */
  trustedIssuers: readonly string[]
  stateStore: MandalaStateStore
  engineOutputs: EngineOutputReader
  screeningProvider: ScreeningProvider
  membership?: MembershipProvider
  /** Exempt from access mode and membership, e.g. the overlay identity key. Trusted issuers always are. */
  membershipExempt?: readonly string[]
  /**
   * The §4.2a rule 3 repair log: called with the outpoint of every owner-index row repaired inline
   * (`inserted` false: an existing row was corrected). Defaults to `console.warn`.
   */
  onOwnerRepair?: (outpoint: string, inserted: boolean) => void
}

const COMPRESSED_KEY = /^0[23][0-9a-f]{64}$/

// The one spelling the layers compare against: compressed, lowercase, and a
// point on the curve that encodes back to the same bytes.
function isCanonicalKey(key: unknown): key is string {
  if (typeof key !== 'string' || !COMPRESSED_KEY.test(key)) return false
  try {
    return PublicKey.fromString(key).toString() === key
  } catch {
    return false
  }
}

/** A configuration fault, so a plain Error at construction rather than a reject per transaction. */
function trustedSet(keys: readonly string[]): ReadonlySet<string> {
  if (!Array.isArray(keys) || keys.length === 0) {
    throw new Error('MandalaTopicManager: trustedIssuers must be a non-empty array')
  }
  const trusted = new Set<string>()
  for (const key of keys) {
    if (!isCanonicalKey(key)) {
      throw new Error(
        `MandalaTopicManager: trusted issuer ${String(key)} is not a compressed lowercase public key`
      )
    }
    if (trusted.has(key)) {
      throw new Error(`MandalaTopicManager: trusted issuer ${key} is listed more than once`)
    }
    trusted.add(key)
  }
  return trusted
}

const journalRows = (
  txid: string,
  owners: readonly VerifiedOwner[],
  createdAt: Date
): MandalaOwnerRecord[] =>
  owners.map(o => ({
    txid,
    outputIndex: o.index,
    topic: MANDALA_TOPIC,
    tokenId: o.tokenId,
    role: o.role,
    // layer B caps every amount at 2^53-1, so this is exact
    amount: Number(o.amount),
    identityKey: o.identityKey,
    createdAt
  }))

const ascendingIndices = (outputs: readonly Brc162Output[]): number[] =>
  outputs.map(o => o.index).sort((a, b) => a - b)

const logOwnerRepair = (outpoint: string, inserted: boolean): void => {
  const what = inserted ? 'row inserted' : 'row corrected'
  console.warn(
    `[MandalaTopicManager] owner index repaired for ${outpoint} from the owner journal (${what})`
  )
}

export class MandalaTopicManager implements TopicManager {
  private readonly deps: MandalaTopicManagerDeps
  private readonly trusted: ReadonlySet<string>
  private readonly exempt: ReadonlySet<string>

  constructor(deps: MandalaTopicManagerDeps) {
    this.trusted = trustedSet(deps.trustedIssuers)
    this.exempt = new Set([...this.trusted, ...(deps.membershipExempt ?? [])])
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
      topic: MANDALA_TOPIC,
      onRepair: this.deps.onOwnerRepair ?? logOwnerRepair
    })

    // layers C and D
    const auth = await checkAuthority(txid, ledger, outputs, owners, env, {
      trustedIssuers: this.trusted,
      store,
      registry: false
    })
    await checkControls(ledger, inputs, inputOwners, owners, auth, {
      store,
      screening: this.deps.screeningProvider,
      membership: this.deps.membership,
      exempt: this.exempt
    })

    if (outputs.length > 0 && context?.dryRun !== true) await this.journal(txid, owners)
    return { outputsToAdmit: ascendingIndices(outputs), coinsToRetain: previousCoins }
  }

  /**
   * §4.2a rule 1: the append-only owner journal, the source every owner-row repair reads. A failed
   * write keeps the store's error as `cause`, since the engine logs only what is thrown.
   */
  private async journal(txid: string, owners: readonly VerifiedOwner[]): Promise<void> {
    try {
      await this.deps.stateStore.recordOwners(journalRows(txid, owners, new Date()))
    } catch (cause) {
      const { code, reason } = Reasons.storeUnavailable('the owner journal')
      throw new MandalaReject(code, reason, { cause })
    }
  }

  async getDocumentation(): Promise<string> {
    return docs
  }

  async getMetaData(): Promise<{ name: string; shortDescription: string }> {
    return {
      name: MANDALA_TOPIC,
      shortDescription:
        'Mandala regulated fungible tokens on BRC-162 (BSV-21 binary, authority supply) with identity linkage, owner-index repair and issuer controls.'
    }
  }
}
