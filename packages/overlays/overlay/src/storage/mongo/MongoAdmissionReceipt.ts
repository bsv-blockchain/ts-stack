import { Binary } from 'mongodb'
import {
  admissionSemanticDigest,
  asStorageUint64,
  type AdmissionIdentity,
  type AdmissionReceipt,
  type RetainedAdmission
} from '../AdmissionStorage.js'

/** Server time written with the original committed operation, never the recovery clock. */
export function mongoAdmissionAcceptedAt(
  input: unknown
): NonNullable<RetainedAdmission['acceptedAt']> {
  if (!(input instanceof Date) || !Number.isSafeInteger(input.getTime()) || input.getTime() < 0)
    throw new Error('Corrupt Mongo admission acceptance timestamp')
  return asStorageUint64(String(Math.floor(input.getTime() / 1000)))
}

export function copyReceipt(receipt: AdmissionReceipt): AdmissionReceipt {
  if (
    receipt.durability !== 'atomic-local' ||
    typeof receipt.steak !== 'string' ||
    !receipt.steak.isWellFormed() ||
    !Array.isArray(receipt.indexes) ||
    receipt.indexes.some(
      index =>
        typeof index.target !== 'string' ||
        index.target.length === 0 ||
        !index.target.isWellFormed() ||
        (index.state !== 'visible' && index.state !== 'pending')
    ) ||
    (receipt.propagation !== 'not-requested' && receipt.propagation !== 'pending')
  )
    throw new Error('Invalid Mongo transaction receipt')
  JSON.parse(receipt.steak)
  const copy: AdmissionReceipt = {
    operationId: receipt.operationId,
    semanticDigest: receipt.semanticDigest,
    durability: 'atomic-local',
    steak: receipt.steak,
    indexes: receipt.indexes.map(index => ({ target: index.target, state: index.state })),
    propagation: receipt.propagation
  }
  if (Buffer.byteLength(JSON.stringify(copy), 'utf8') > 1048576)
    throw new Error('Mongo transaction receipt is too large')
  return copy
}

/** Retain provenance inside existing bounded receipt bytes; public receipt shape is unchanged. */
export function encodeMongoAdmissionReceipt(
  receipt: AdmissionReceipt,
  identity: AdmissionIdentity,
  retainIdentity = false
): Binary {
  if (typeof retainIdentity !== 'boolean')
    throw new Error('Invalid admission-history retention option')
  const value = retainIdentity
    ? {
        ...copyReceipt(receipt),
        admissionHistory: { version: 1, identity: copyAdmissionIdentity(identity) }
      }
    : copyReceipt(receipt)
  const bytes = Buffer.from(JSON.stringify(value), 'utf8')
  if (bytes.byteLength > 1048576) throw new Error('Mongo transaction receipt is too large')
  return new Binary(bytes)
}

export function decodeMongoAdmissionReceipt(value: unknown): {
  receipt: AdmissionReceipt
  identity?: AdmissionIdentity
} {
  if (!(value instanceof Binary)) throw new Error('Committed Mongo operation has no receipt')
  const bytes = Buffer.from(value.value())
  if (bytes.byteLength > 1048576) throw new Error('Mongo transaction receipt is too large')
  const parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes))
  const receipt = copyReceipt(parsed)
  if (parsed.admissionHistory === undefined) return { receipt }
  const history = closedRecord(parsed.admissionHistory, ['version', 'identity'])
  if (history.version !== 1) throw new Error('Unknown Mongo admission-history version')
  const identity = copyAdmissionIdentity(history.identity)
  if (admissionSemanticDigest(identity) !== receipt.semanticDigest)
    throw new Error('Corrupt Mongo admission-history identity')
  return { receipt, identity }
}

function closedRecord(value: unknown, keys: string[]): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    throw new Error('Invalid Mongo admission-history record')
  const record = value as Record<string, unknown>
  if (Object.keys(record).length !== keys.length || keys.some(key => !Object.hasOwn(record, key)))
    throw new Error('Invalid Mongo admission-history fields')
  return record
}

function requiredString(value: unknown): string {
  if (typeof value !== 'string') throw new Error('Invalid Mongo admission-history string')
  return value
}

function copyAdmissionIdentity(value: unknown): AdmissionIdentity {
  const record = closedRecord(value, ['scope', 'txid', 'mode', 'contextDigest', 'topics'])
  const scope = closedRecord(record.scope, ['network', 'genesisHash', 'nodeId'])
  if (!Array.isArray(record.topics) || (record.mode !== 'live' && record.mode !== 'historical'))
    throw new Error('Invalid Mongo admission-history topics or mode')
  const identity: AdmissionIdentity = {
    scope: {
      network: requiredString(scope.network),
      genesisHash: requiredString(scope.genesisHash),
      nodeId: requiredString(scope.nodeId)
    },
    txid: requiredString(record.txid),
    mode: record.mode,
    contextDigest: requiredString(record.contextDigest),
    topics: record.topics.map(value => {
      const topic = closedRecord(value, ['topic', 'policyId'])
      return { topic: requiredString(topic.topic), policyId: requiredString(topic.policyId) }
    })
  }
  admissionSemanticDigest(identity)
  return identity
}

/** Bind a retained record to its original operation; callers separately check topic and context. */
export function retainedMongoAdmission(
  value: unknown,
  operationId: string,
  semanticDigest: string,
  txid: string
): RetainedAdmission | undefined {
  const decoded = decodeMongoAdmissionReceipt(value)
  if (
    decoded.receipt.operationId !== operationId ||
    decoded.receipt.semanticDigest !== semanticDigest
  )
    throw new Error('Corrupt Mongo operation receipt identity')
  if (decoded.identity === undefined) return undefined
  if (decoded.identity.txid !== txid) throw new Error('Corrupt Mongo admission-history transaction')
  return { identity: decoded.identity, receipt: decoded.receipt }
}
