import {
  AdmissionMode,
  LookupFormula,
  LookupQuestion,
  LookupService,
  OutputAdmittedByTopic,
  OutputSpent,
  SpendNotificationMode
} from '@bsv/overlay'
import { Db } from 'mongodb'
import { readUoraAnchor } from './anchorFormat.js'
import { UoraDppQuery } from './types.js'
import { UoraDppStorage } from './UoraDppStorage.js'

const TOPIC = 'tm_uora_dpp'
const SERVICE = 'ls_uora_dpp'

/**
 * `ls_uora_dpp`: attestation anchors, keyed on the party that made the claim.
 *
 * The question this exists for is "what has this party attested", asked with a
 * `did:key` and nothing else. Four other selectors come free from the same
 * fields: the subject (every claim about one product, from every party), the
 * attestation id, the digest (given an attestation in hand, has anyone anchored
 * exactly this), and the anchoring service.
 *
 * ## What the answer is
 *
 * Outputs, as BRC-24 requires, so a caller receives the anchors as chain data
 * and checks them without trusting this index. That matters more here than for
 * most topics: this index is derived entirely from the outputs it returns, so
 * an index that lied would be caught by the caller reading the same outputs.
 *
 * The answer is **not** the attestations. Those are never on chain, so a caller
 * who wants a claim itself fetches it from the issuing registry and checks its
 * canonical digest against the anchor. The anchor is the proof; the registry is
 * merely convenient.
 */
export class UoraDppLookupService implements LookupService {
  readonly admissionMode: AdmissionMode = 'locking-script'
  readonly spendNotificationMode: SpendNotificationMode = 'txid'

  constructor(public storage: UoraDppStorage) {}

  async outputAdmittedByTopic(payload: OutputAdmittedByTopic): Promise<void> {
    if (payload.mode !== 'locking-script') throw new Error('Invalid mode')
    const { topic, txid, outputIndex, lockingScript } = payload
    if (topic !== TOPIC) return
    try {
      const { anchor } = readUoraAnchor(lockingScript)
      await this.storage.storeRecord({ txid, outputIndex, ...anchor })
    } catch (error) {
      // Admission already validated this output, so a failure here means the
      // topic manager and this reader disagree. Indexing half an anchor would
      // be worse than indexing none.
      console.error(`UoraDppLookupService: failed to index ${txid}.${outputIndex}`, error)
    }
  }

  /**
   * An anchor is a leaf and should never be spent. If one is, the claim it
   * carries is unaffected: the digest sat at that point in the chain's order
   * whatever later became of the satoshi. So nothing is recorded here.
   */
  async outputSpent(payload: OutputSpent): Promise<void> {
    if (payload.mode !== 'txid') throw new Error('Invalid mode')
  }

  async outputNoLongerRetainedInHistory(
    txid: string,
    outputIndex: number,
    topic: string
  ): Promise<void> {
    if (topic !== TOPIC) return
    await this.storage.deleteRecord(txid, outputIndex)
  }

  async outputEvicted(txid: string, outputIndex: number): Promise<void> {
    await this.storage.deleteRecord(txid, outputIndex)
  }

  async lookup(question: LookupQuestion): Promise<LookupFormula> {
    if (question === undefined || question === null) throw new Error('A valid query is required!')
    if (question.service !== SERVICE) throw new Error('Lookup service not supported!')

    const query = (question.query ?? {}) as UoraDppQuery
    if (query.limit !== undefined && query.limit < 0) {
      throw new Error('Limit must be a non-negative number')
    }
    if (query.skip !== undefined && query.skip < 0) {
      throw new Error('Skip must be a non-negative number')
    }

    // `uoraType` and `anchoredBy` narrow but cannot select: either alone is
    // every anchor of a common type, which is a table scan wearing a query.
    //
    // Tested the same way the storage layer uses them, which is a non-empty
    // string, rather than merely being present. Testing for presence let
    // `{ issuer: '' }` through: it satisfied the guard, then the storage layer
    // dropped it for not being a usable string, and what reached Mongo was an
    // empty filter. The caller got the table scan this guard exists to refuse,
    // and could page the whole collection with `skip`.
    const selects = (value: unknown): boolean => typeof value === 'string' && value !== ''
    const selective =
      selects(query.issuer) ||
      selects(query.issuerKey) ||
      selects(query.subject) ||
      selects(query.attestationId) ||
      selects(query.digest)
    if (!selective) {
      throw new Error('Query must provide issuer, issuerKey, subject, attestationId or digest')
    }

    return await this.storage.find(query)
  }

  async getDocumentation(): Promise<string> {
    return [
      'UORA DPP Lookup Service: attestation anchors, keyed on the issuing party.',
      '',
      'Query with at least one of issuer (a did:key), issuerKey (the same key as',
      'hex), subject (a product passport id), attestationId or digest. uoraType',
      'and anchoredBy narrow any of those and cannot select on their own. All',
      'are exact matches; limit and skip page the answer and limit is capped.',
      '',
      'Answers are anchor outputs, so a caller verifies them against the chain',
      'rather than trusting this index. The attestations themselves are never on',
      'chain: fetch one from the issuing registry and check its canonical digest',
      "against the anchor's."
    ].join('\n')
  }

  async getMetaData(): Promise<{
    name: string
    shortDescription: string
    iconURL?: string
    version?: string
    informationURL?: string
  }> {
    return {
      name: 'UORA DPP Lookup Service',
      shortDescription: 'Find attestation anchors by the party that made the claim',
      version: '1.0.0'
    }
  }
}

function create(db: Db): UoraDppLookupService {
  return new UoraDppLookupService(new UoraDppStorage(db))
}
export default create
