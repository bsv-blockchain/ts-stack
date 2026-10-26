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
import { identityKeyFromDidKey, readUoraAnchor } from './anchorFormat.js'
import { UoraDppQuery } from './types.js'
import { UoraDppStorage } from './UoraDppStorage.js'
import docs from './UoraDppLookupDocs.md.js'
import {
  readInteger,
  readString,
  requireHex,
  requireLookupQuery,
  requirePublicKey
} from '../shared/queryValidation.js'

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
    const raw = requireLookupQuery(question, SERVICE, [
      'issuer',
      'issuerKey',
      'subject',
      'attestationId',
      'digest',
      'anchoredBy',
      'uoraType',
      'limit',
      'skip'
    ])
    const issuer = readString(raw, 'issuer', { maxBytes: 128 })
    if (issuer !== undefined && identityKeyFromDidKey(issuer) === undefined) {
      throw new Error('Invalid lookup query: issuer must be a canonical secp256k1 did:key')
    }
    const query: UoraDppQuery = {
      issuer,
      issuerKey: requirePublicKey(readString(raw, 'issuerKey', { maxBytes: 66 }), 'issuerKey'),
      subject: readString(raw, 'subject', { maxBytes: 512 }),
      attestationId: readString(raw, 'attestationId', { maxBytes: 256 }),
      digest: requireHex(readString(raw, 'digest', { maxBytes: 64 }), 'digest', 32),
      anchoredBy: requirePublicKey(readString(raw, 'anchoredBy', { maxBytes: 66 }), 'anchoredBy'),
      uoraType: readString(raw, 'uoraType', { maxBytes: 64 }),
      limit: readInteger(raw, 'limit', 500, 1, 500),
      skip: readInteger(raw, 'skip', 0, 0, 100000)
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
    const selective =
      query.issuer !== undefined ||
      query.issuerKey !== undefined ||
      query.subject !== undefined ||
      query.attestationId !== undefined ||
      query.digest !== undefined
    if (!selective) {
      throw new Error('Query must provide issuer, issuerKey, subject, attestationId or digest')
    }

    return await this.storage.find(query)
  }

  async getDocumentation(): Promise<string> {
    return docs
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
