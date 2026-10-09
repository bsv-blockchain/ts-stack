import * as s from './OutputProtocolSchema.js'
import {
  parseOutputReleasePolicy,
  parseOutputReleasePolicyWithInlineStrings,
  validateOutputReleasePolicyOfOwnedParent,
  type OutputReleasePolicy
} from './OutputCapabilities.js'
import {
  decodeOutputBytes,
  outputU64,
  verifyOutputPacket,
  type OutputChain
} from './OutputProtocol.js'
import { canonicalOutputJSON, canonicalOutputJSONWithInlineRecords } from './OutputProtocolJSON.js'
import { outputAssert } from './OutputProtocolError.js'
import { toArray, toBase64 } from '../primitives/utils.js'

export const OUTPUT_PROCESSOR_ATTESTATION_POLICY =
  'https://bsv.brc.dev/overlays/0196#processor-attestation-v1'

const block = s.fixedObject({
  blockHash: s.hex,
  height: s.u64,
  tipHash: s.hex,
  tipHeight: s.u64,
  beef: s.bytes,
  contextId: s.text,
  chainPolicyDigest: s.hex
})
const release = s.fixedObject(
  { chain: s.chain, txid: s.hex, policy: parseOutputReleasePolicy, acceptedAt: s.u64 },
  { processorEvidence: s.bytes, blockEvidence: block }
)
const processor = s.fixedObject({
  body: s.fixedObject({
    version: s.literal(1),
    chain: s.chain,
    txid: s.hex,
    policy: s.iri,
    acceptedAt: s.u64
  }),
  signature: s.bytes
})

export type OutputReleaseEvidence = ReturnType<typeof release>
export type OutputProcessorAcceptance = ReturnType<typeof processor>
export interface OutputReleaseBinding {
  chain: OutputChain
  txid: string
  /** Independently selected policy, never copied from an untrusted response. */
  policy: OutputReleasePolicy
}

/**
 * Owned, bounded BRC-196 representation and intrinsic arithmetic only. This
 * does not verify a processor signature, BEEF, headers, ancestry or currentness.
 */
export function parseOutputReleaseEvidence(input: unknown): OutputReleaseEvidence {
  const result = s.normalized(input, release),
    policy = result.policy
  outputAssert(
    Object.hasOwn(result, 'processorEvidence') === (policy.kind === 'processor-accepted') &&
      Object.hasOwn(result, 'blockEvidence') === (policy.kind === 'mined'),
    'Release evidence fields differ from policy'
  )
  if (policy.kind === 'mined') {
    const evidence = result.blockEvidence!
    const height = outputU64(evidence.height),
      tip = outputU64(evidence.tipHeight)
    outputAssert(
      tip >= height && tip - height + 1n >= BigInt(policy.confirmations),
      'Insufficient declared confirmation depth'
    )
    outputAssert(
      tip !== height || evidence.tipHash === evidence.blockHash,
      'Same-height release headers differ'
    )
  }
  return result
}

/** Bind a representation to caller-selected facts without making an acceptance verdict. */
export function bindOutputReleaseEvidence(
  input: unknown,
  expected: OutputReleaseBinding
): OutputReleaseEvidence {
  const binding = s.normalized(
    expected,
    s.fixedObject({
      chain: s.chain,
      txid: s.hex,
      policy: parseOutputReleasePolicy
    })
  )
  const evidence = parseOutputReleaseEvidence(input)
  outputAssert(
    canonicalOutputJSON(evidence.chain) === canonicalOutputJSON(binding.chain) &&
      evidence.txid === binding.txid &&
      canonicalOutputJSON(evidence.policy) === canonicalOutputJSON(binding.policy),
    'Release evidence binding mismatch'
  )
  return evidence
}

/**
 * Verify the registered processor's exact signed acceptance statement. The caller
 * independently chooses/trusts expected.policy. Success is not proof of mining,
 * universal availability, secret delivery or an economic finality guarantee.
 */
export function verifyOutputProcessorAcceptance(
  input: unknown,
  expected: OutputReleaseBinding
): OutputProcessorAcceptance {
  const evidence = bindOutputReleaseEvidence(input, expected)
  const policy = evidence.policy
  outputAssert(policy.kind === 'processor-accepted', 'Processor policy required')
  outputAssert(
    policy.policy === OUTPUT_PROCESSOR_ATTESTATION_POLICY,
    'Unsupported processor attestation policy',
    'unsupported'
  )
  const packet = s.normalized(
    Uint8Array.from(decodeOutputBytes(evidence.processorEvidence!)),
    processor
  )
  outputAssert(
    toBase64(toArray(canonicalOutputJSON(packet), 'utf8')) === evidence.processorEvidence,
    'Processor attestation must use UTF-8 canonical JSON'
  )
  outputAssert(
    canonicalOutputJSON(packet.body.chain) === canonicalOutputJSON(evidence.chain) &&
      packet.body.txid === evidence.txid &&
      packet.body.policy === policy.policy &&
      packet.body.acceptedAt === evidence.acceptedAt,
    'Processor attestation binding mismatch'
  )
  outputAssert(
    verifyOutputPacket('processor-acceptance', packet, policy.identity),
    'Processor attestation signature failed',
    'unauthorized'
  )
  return packet
}

/** Explicit fresh-ownership companion. Every representation, arithmetic and binding
 * check is repeated; no input, custody, currentness or validation result is retained. */
export function parseOutputReleaseEvidenceWithInlineStrings(input: unknown): OutputReleaseEvidence {
  const result = s.normalizedWithInlineStrings(input, releaseWithInlineStrings()),
    policy = result.policy
  outputAssert(
    Object.hasOwn(result, 'processorEvidence') === (policy.kind === 'processor-accepted') &&
      Object.hasOwn(result, 'blockEvidence') === (policy.kind === 'mined'),
    'Release evidence fields differ from policy'
  )
  if (policy.kind === 'mined') {
    const evidence = result.blockEvidence!
    const height = outputU64(evidence.height),
      tip = outputU64(evidence.tipHeight)
    outputAssert(
      tip >= height && tip - height + 1n >= BigInt(policy.confirmations),
      'Insufficient declared confirmation depth'
    )
    outputAssert(
      tip !== height || evidence.tipHash === evidence.blockHash,
      'Same-height release headers differ'
    )
  }
  return result
}

/** Explicit fresh-ownership companion. Every representation, arithmetic and binding
 * check is repeated; no input, custody, currentness or validation result is retained. */
export function bindOutputReleaseEvidenceWithInlineStrings(
  input: unknown,
  expected: OutputReleaseBinding
): OutputReleaseEvidence {
  const binding = s.normalizedWithInlineStrings(
    expected,
    s.fixedObject({
      chain: s.chain,
      txid: s.hex,
      policy: s.fromOwnedParent(
        parseOutputReleasePolicyWithInlineStrings,
        validateOutputReleasePolicyOfOwnedParent
      )
    })
  )
  const evidence = parseOutputReleaseEvidenceWithInlineStrings(input)
  outputAssert(
    canonicalOutputJSONWithInlineRecords(evidence.chain) ===
      canonicalOutputJSONWithInlineRecords(binding.chain) &&
      evidence.txid === binding.txid &&
      canonicalOutputJSONWithInlineRecords(evidence.policy) ===
        canonicalOutputJSONWithInlineRecords(binding.policy),
    'Release evidence binding mismatch'
  )
  return evidence
}

// Fixed companion grammar only; every supplied value is owned and checked afresh.
let releaseWithInlineStringsGrammar: s.Schema<OutputReleaseEvidence> | undefined
function releaseWithInlineStrings(): s.Schema<OutputReleaseEvidence> {
  releaseWithInlineStringsGrammar ??= s.fixedObject(
    {
      chain: s.chain,
      txid: s.hex,
      policy: s.fromOwnedParent(
        parseOutputReleasePolicyWithInlineStrings,
        validateOutputReleasePolicyOfOwnedParent
      ),
      acceptedAt: s.u64
    },
    { processorEvidence: s.bytes, blockEvidence: block }
  )
  return releaseWithInlineStringsGrammar
}

/** @internal Child grammar and intrinsic arithmetic for an enclosing packet that
 * was freshly owned and bounded in full. Standalone input requires the complete
 * parser. No signature, custody, chain or currentness verdict is implied. */
export function validateOutputReleaseEvidenceOfOwnedParent(input: unknown): OutputReleaseEvidence {
  const result = releaseWithInlineStrings()(input),
    policy = result.policy
  outputAssert(
    Object.hasOwn(result, 'processorEvidence') === (policy.kind === 'processor-accepted') &&
      Object.hasOwn(result, 'blockEvidence') === (policy.kind === 'mined'),
    'Release evidence fields differ from policy'
  )
  if (policy.kind === 'mined') {
    const evidence = result.blockEvidence!
    const height = outputU64(evidence.height),
      tip = outputU64(evidence.tipHeight)
    outputAssert(
      tip >= height && tip - height + 1n >= BigInt(policy.confirmations),
      'Insufficient declared confirmation depth'
    )
    outputAssert(
      tip !== height || evidence.tipHash === evidence.blockHash,
      'Same-height release headers differ'
    )
  }
  return result
}
