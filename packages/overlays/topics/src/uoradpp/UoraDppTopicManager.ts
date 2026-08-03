import { AdmittanceInstructions, TopicManager } from '@bsv/overlay'
import { LockingScript } from '@bsv/sdk'
import { identifyPushDropOutputs } from '../shared/identifyPushDropOutputs.js'
import { assertAnchorSignature, readUoraAnchor } from './anchorFormat.js'
import docs from './UoraDppTopicDocs.md.js'

/**
 * `tm_uora_dpp`: admission for UORA attestation anchors.
 *
 * A UORA attestation is a claim one party makes about one product. The claim
 * itself is never on chain; the anchor is its digest, plus the issuer, the
 * subject, the type and the anchoring service, in the clear so an index can be
 * keyed on them.
 *
 * ## What admission proves, and what it does not
 *
 * **Proved.** The seven fields were sealed together by the key locking the
 * output, and that key is the BRC-42 child of the anchoring service named in
 * field 6 under counterparty `anyone`. Producing an output that satisfies both
 * needs that service's private key, so every admitted anchor names its author
 * checkably, by anyone holding the transaction, with nothing configured.
 *
 * "Sealed together" is doing exact work here, and it is what v2 could not
 * deliver. The signature covers each field behind its own length, so it fixes
 * where every field ends as well as what they contain. v2 signed the field
 * bytes run together, which fixed only the total string: the subject and the
 * type are adjacent and neither has its boundary pinned by any other check, so
 * a holder could re-cut that boundary into a different subject and type, keep
 * the signature, and be admitted. The derivation check does not catch it,
 * because the two fields it pins are the two a re-cut leaves alone.
 *
 * **Not proved.** That the party in field 3 made the claim. That is a `did:key`
 * copied onto the chain as given, and anyone able to write an anchor can write
 * any DID into it. What a claim is worth is settled by the attestation's own
 * signature, which is off chain by design. This topic is a finding aid, and its
 * value is that what it finds can be checked without it.
 *
 * ## Why an instance need not be configured
 *
 * Field 6 carries the anchoring service rather than the reader being told which
 * services to expect. A shared node serving several deployments would otherwise
 * need amending whenever one was added, and a reader holding only the
 * transaction could not attribute it at all. `anchorServiceKeys` narrows what
 * this instance carries and is a preference about what to index, not a
 * boundary: every anchor it admits says whose it is either way.
 *
 * ## Anchors are leaves
 *
 * Never spent, no predecessor, no transition rules, nothing retained, so
 * `previousCoins` is not consulted. Every valid anchor in a transaction is
 * admitted rather than exactly one, which leaves a service free to batch a
 * fleet's worth into a single transaction without this topic changing.
 */
export default class UoraDppTopicManager implements TopicManager {
  private readonly accepted: readonly string[]

  constructor(anchorServiceKeys: readonly string[] = []) {
    this.accepted = anchorServiceKeys.filter(key => key !== '')
  }

  async identifyAdmissibleOutputs(
    beef: number[],
    previousCoins: number[]
  ): Promise<AdmittanceInstructions> {
    return await identifyPushDropOutputs({
      beef,
      previousCoins,
      validateOutput: async (lockingScript: LockingScript) => {
        const { anchor, fields } = readUoraAnchor(lockingScript)
        await assertAnchorSignature(fields, anchor.anchoredBy, anchor.attestationId)
        if (this.accepted.length > 0 && !this.accepted.includes(anchor.anchoredBy)) {
          throw new Error('this instance does not carry anchors from that service')
        }
      },
      onRejectedOutput: (outputIndex, error) => {
        console.debug(`[UoraDppTopicManager] Skipping output ${outputIndex}: ${String(error)}`)
      }
    })
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
      name: 'UORA DPP Topic Manager',
      shortDescription: 'Attestation anchors for digital product passports',
      version: '1.0.0'
    }
  }
}
