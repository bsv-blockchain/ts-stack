import {
  canonicalOutputJSON,
  closedOutputObject,
  decodeOutputBytes,
  OutputProtocolError,
  outputU32,
  parseOutputJSON,
  Utils,
  type OutputJSONObject,
  type OutputProposalBody,
  type Transaction
} from '@bsv/sdk'
import type { ProposalAction, ProposalPolicy } from './ProposalPolicy.js'

/** Concrete BRC-194 document policy; contains no wallet, networking or storage effects. */
export class AuthorDocumentPolicy implements ProposalPolicy {
  readonly id = 'https://bsv.brc.dev/overlays/0194#author-document-v1'

  parameters(input: unknown): OutputJSONObject {
    closedOutputObject(input, ['maxTextBytes'])
    const maximum = outputU32(input.maxTextBytes)
    requireDocument(maximum >= 1 && maximum <= 4096, 'Invalid document text limit')
    return { maxTextBytes: maximum }
  }

  validate(body: OutputProposalBody, parameters: OutputJSONObject): void {
    requireDocument(
      body.transaction === undefined,
      'Document proposals cannot contain transactions'
    )
    requireDocument(
      body.recipients.length >= 1 &&
        body.recipients.length <= 32 &&
        body.recipients.includes(body.author),
      'Document recipients must include the author and contain 1–32 identities'
    )
    requireDocument(body.anchors.length <= 1, 'Document proposals allow at most one anchor')
    // A JSON string can use six ASCII escape bytes for one text code unit.
    const maximum = this.parameters(parameters).maxTextBytes as number
    const bytes = decodeOutputBytes(body.payload, maximum * 6 + 11)
    const payload = parseOutputJSON(Uint8Array.from(bytes), { bytes: maximum * 6 + 11 })
    closedOutputObject(payload, ['text'])
    requireDocument(typeof payload.text === 'string', 'Document text must be a string')
    requireDocument(
      new TextEncoder().encode(payload.text).length <= maximum,
      'Document text exceeds its installed limit'
    )
    requireDocument(
      Utils.toBase64(Utils.toArray(canonicalOutputJSON(payload), 'utf8')) === body.payload,
      'Document payload must be canonical UTF-8 JSON'
    )
  }

  permits(action: ProposalAction, body: OutputProposalBody, caller: string): boolean {
    return action === 'read' ? body.recipients.includes(caller) : caller === body.author
  }

  successor(previous: OutputProposalBody, next: OutputProposalBody): void {
    requireDocument(
      previous.author === next.author &&
        canonicalOutputJSON(previous.recipients) === canonicalOutputJSON(next.recipients) &&
        canonicalOutputJSON(previous.anchors) === canonicalOutputJSON(next.anchors),
      'Document revisions must retain author, recipients and anchors'
    )
  }

  finalization(body: OutputProposalBody, proposalId: string, transaction: Transaction): void {
    const output = transaction.outputs[0]
    const expected = '006a045052503120' + proposalId
    requireDocument(
      output?.satoshis === 1 && output.lockingScript.toHex() === expected,
      'Document finalization requires the exact one-satoshi PRP1 output at index zero'
    )
    const anchor = body.anchors[0]
    if (anchor !== undefined) {
      const input = transaction.inputs[0]
      requireDocument(
        input?.sourceTXID === anchor.txid && input.sourceOutputIndex === anchor.outputIndex,
        'Document finalization must spend its anchor at input zero'
      )
    }
  }
}

function requireDocument(condition: unknown, message: string): asserts condition {
  if (!condition) throw new OutputProtocolError('invalid', message)
}
