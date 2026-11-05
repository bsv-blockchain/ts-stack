import * as s from './OutputProtocolSchema.js'
import {
  decodeOutputBytes,
  outputPacketDigest,
  validateOutputExtensions
} from './OutputProtocol.js'
import { outputAssert } from './OutputProtocolError.js'

const publish = s.fixedObject(
  {
    version: s.literal(1),
    requestId: s.requestId,
    topic: s.text,
    evidence: s.evidence,
    assetId: s.hex,
    schema: s.text,
    privateValues: s.bytes
  },
  s.extensions
)
const status = s.fixedObject({ version: s.literal(1), publicationId: s.hex })
const result = s.fixedObject(
  {
    version: s.literal(1),
    publicationId: s.hex,
    txid: s.hex,
    status: s.literal('pending', 'ready', 'unavailable', 'rejected', 'expired'),
    updatedAt: s.u64
  },
  { reason: s.text }
)

export type OutputPrivatePublish = ReturnType<typeof publish>
export type OutputPrivatePublicationStatus = ReturnType<typeof status>
export type OutputPrivatePublicationResult = ReturnType<typeof result>

/** Owned BRC-195 representation. Authority, asset/key validation and protected storage are separate. */
export function parseOutputPrivatePublish(
  input: unknown,
  supportedExtensions: readonly string[] = []
): OutputPrivatePublish {
  const value = s.normalized(input, publish)
  validateOutputExtensions(value, supportedExtensions)
  outputAssert(
    decodeOutputBytes(value.privateValues).length <= 1048576,
    'Private publication payload exceeds 1 MiB',
    'limited'
  )
  return value
}

/** Public evidence variants share a semantic fence only after independent target/output verification. */
export function outputPrivatePublicationRequestDigest(
  input: unknown,
  supportedExtensions: readonly string[] = []
): string {
  const value = parseOutputPrivatePublish(input, supportedExtensions)
  return outputPacketDigest('publication-request', {
    ...value,
    evidence: { txid: value.evidence.txid, outputIndex: value.evidence.outputIndex }
  })
}

/** Authorization must precede lookup; unauthorized and absent records use the same not-found response. */
export const parseOutputPrivatePublicationStatus = (
  input: unknown
): OutputPrivatePublicationStatus => s.normalized(input, status)

/** A parsed ready claim does not establish the durable admission/binding barrier. */
export function parseOutputPrivatePublicationResult(
  input: unknown
): OutputPrivatePublicationResult {
  const value = s.normalized(input, result)
  outputAssert(
    !['rejected', 'expired'].includes(value.status) || value.reason !== undefined,
    'Terminal publication requires a retained reason'
  )
  return value
}
