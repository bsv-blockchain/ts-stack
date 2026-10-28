import {
  ownOutputJSON,
  canonicalOutputJSON,
  closedOutputObject,
  Hash,
  incrementOutputU64,
  outputAssert,
  outputHex32,
  outputU64,
  parseOutputJSON,
  Utils,
  type OutputJSONObject
} from '@bsv/sdk'
import type {
  OperationStateStore,
  OperationStateSnapshot,
  OperationStateResult
} from './OperationStateStore.js'
import type { ProtectedOperationPayload } from './ProtectedOperationPayload.js'
const CONFIGURATION = 'output-protected-operation/1'
const EMPTY = 'output-protected-operation-empty/1'
const SEALED = 'output-protected-operation-sealed/1'
const VALUE = 'output-protected-operation-value/1'
export const PROTECTED_OPERATION_INITIAL: Readonly<OutputJSONObject> = Object.freeze({
  format: EMPTY
})
export interface ProtectedOperationConfiguration {
  /** Public local binding only; private requests and responses belong in encrypted state. */
  binding: OutputJSONObject
  maximumValueBytes: number
}
function object(input: unknown, bytes: number): OutputJSONObject {
  const value = ownOutputJSON(input, { bytes }).value
  outputAssert(
    value !== null && typeof value === 'object' && !Array.isArray(value),
    'Expected protected operation object'
  )
  return value
}
const digest = (text: string): string =>
  Utils.toHex(Hash.sha256(Utils.toArray(CONFIGURATION + '\0' + text, 'utf8')))
/** Use this exact public binding with an existing SQLite or IndexedDB CAS store. */
export function protectedOperationBinding(
  options: ProtectedOperationConfiguration,
  codec: ProtectedOperationPayload
): OutputJSONObject {
  outputAssert(
    typeof codec.id === 'string' &&
      codec.id.length > 0 &&
      codec.id.length <= 128 &&
      Number.isSafeInteger(codec.maximumPlaintextBytes) &&
      codec.maximumPlaintextBytes >= 256 &&
      codec.maximumPlaintextBytes <= 2097152 &&
      Number.isSafeInteger(codec.maximumSealedBytes) &&
      codec.maximumSealedBytes > 0 &&
      codec.maximumSealedBytes <= 4194048,
    'Invalid protected operation codec capacity'
  )
  outputAssert(
    Number.isSafeInteger(options.maximumValueBytes) &&
      options.maximumValueBytes > 0 &&
      options.maximumValueBytes <= codec.maximumPlaintextBytes - 256,
    'Protected operation value exceeds plaintext reservation',
    'limited'
  )
  return object(
    {
      format: CONFIGURATION,
      binding: object(options.binding, 16384),
      codec: codec.id,
      maximumValueBytes: options.maximumValueBytes,
      maximumPlaintextBytes: codec.maximumPlaintextBytes,
      maximumSealedBytes: codec.maximumSealedBytes
    },
    32768
  )
}
interface Decoded {
  revision: string
  initialDigest: string
  value: OutputJSONObject
}
/**
 * Additive encrypted workflow cell over the existing durable native/browser CAS
 * ports. Initialize explicitly; open cannot recreate lost state. Revision zero
 * is reserved for the empty installation, and the first protected value is one.
 * Ciphertext does not detect rollback of an entire valid store or grant authority
 * to spend, disclose or erase retained paid results.
 */
export class ProtectedOperationStateStore implements OperationStateStore {
  readonly durability = 'durable' as const
  readonly namespace: string
  private readonly binding: OutputJSONObject
  private readonly baseConfiguration: string
  private readonly identities: readonly (() => boolean)[]
  private readonly valueBytes: number
  private readonly plaintextBytes: number
  private readonly sealedBytes: number
  private closed = false
  private constructor(
    private readonly base: OperationStateStore,
    private readonly codec: ProtectedOperationPayload,
    options: ProtectedOperationConfiguration
  ) {
    this.namespace = base.namespace
    this.binding = protectedOperationBinding(options, codec)
    this.valueBytes = options.maximumValueBytes
    this.plaintextBytes = codec.maximumPlaintextBytes
    this.sealedBytes = codec.maximumSealedBytes
    this.baseConfiguration = canonicalOutputJSON(base.configuration, { bytes: 2097152 })
    outputAssert(
      base.durability === 'durable' &&
        canonicalOutputJSON(base.configuration.binding) === canonicalOutputJSON(this.binding),
      'Protected operation requires its original durable store binding',
      'context-changed'
    )
    outputAssert(
      base.configuration.limits.stateBytes >= codec.maximumSealedBytes + 128,
      'Protected operation ciphertext lacks complete storage reservation',
      'limited'
    )
    this.identities = [
      pin(base, 'read'),
      pin(base, 'compareAndSwap'),
      pin(base, 'close'),
      pin(codec, 'seal'),
      pin(codec, 'open')
    ]
    this.current()
  }
  static async initialize(
    base: OperationStateStore,
    codec: ProtectedOperationPayload,
    options: ProtectedOperationConfiguration,
    initial: OutputJSONObject
  ): Promise<ProtectedOperationStateStore> {
    const owner = new ProtectedOperationStateStore(base, codec, options)
    const value = object(initial, owner.valueBytes),
      initialDigest = digest(canonicalOutputJSON(value, { bytes: owner.valueBytes }))
    const snapshot = await base.read()
    owner.current()
    if (canonicalOutputJSON(snapshot.value) === canonicalOutputJSON(PROTECTED_OPERATION_INITIAL)) {
      outputAssert(
        snapshot.revision === '0',
        'Protected operation empty state has another revision',
        'unavailable'
      )
      const envelope = await owner.encode('1', initialDigest, value)
      owner.current()
      await base.compareAndSwap('0', envelope)
      owner.current()
    }
    const saved = await owner.decoded()
    outputAssert(
      saved.initialDigest === initialDigest,
      'Protected operation initialization conflicts',
      'conflict'
    )
    return owner
  }
  static async open(
    base: OperationStateStore,
    codec: ProtectedOperationPayload,
    options: ProtectedOperationConfiguration
  ): Promise<ProtectedOperationStateStore> {
    const owner = new ProtectedOperationStateStore(base, codec, options)
    await owner.decoded()
    return owner
  }
  get configuration(): OperationStateStore['configuration'] {
    return {
      binding: object(this.binding.binding, 16384),
      limits: { configurationBytes: 32768, stateBytes: this.valueBytes }
    }
  }
  private current(): void {
    outputAssert(!this.closed, 'Protected operation store is closed', 'unavailable')
    outputAssert(
      this.base.namespace === this.namespace &&
        this.base.durability === 'durable' &&
        canonicalOutputJSON(this.base.configuration, { bytes: 2097152 }) ===
          this.baseConfiguration &&
        this.codec.id === this.binding.codec &&
        this.codec.maximumPlaintextBytes === this.plaintextBytes &&
        this.codec.maximumSealedBytes === this.sealedBytes &&
        this.identities.every(check => check()),
      'Protected operation installed capabilities changed',
      'context-changed'
    )
  }
  private aad(revision: string): OutputJSONObject {
    return {
      format: CONFIGURATION,
      namespace: this.namespace,
      configuration: digest(this.baseConfiguration),
      revision: outputU64(revision).toString()
    }
  }
  private async encode(
    revision: string,
    initialDigest: string,
    value: OutputJSONObject
  ): Promise<OutputJSONObject> {
    this.current()
    const text = canonicalOutputJSON(
        { format: VALUE, initialDigest, value },
        { bytes: this.plaintextBytes }
      ),
      bytes = new TextEncoder().encode(text)
    try {
      const payload = object(await this.codec.seal(this.aad(revision), bytes), this.sealedBytes)
      this.current()
      return object({ format: SEALED, payload }, this.sealedBytes + 128)
    } finally {
      bytes.fill(0)
    }
  }
  private async decoded(): Promise<Decoded> {
    this.current()
    const snapshot = await this.base.read()
    this.current()
    const saved = object(snapshot.value, this.sealedBytes + 128)
    closedOutputObject(saved, ['format', 'payload'])
    outputAssert(
      saved.format === SEALED,
      'Protected operation has not been initialized',
      'unavailable'
    )
    const bytes = await this.codec.open(this.aad(snapshot.revision), saved.payload)
    try {
      this.current()
      outputAssert(
        bytes instanceof Uint8Array && bytes.byteLength <= this.plaintextBytes,
        'Protected operation plaintext capacity exceeded',
        'limited'
      )
      const plain = parseOutputJSON(bytes, { bytes: this.plaintextBytes })
      closedOutputObject(plain, ['format', 'initialDigest', 'value'])
      outputAssert(
        plain.format === VALUE,
        'Protected operation value format changed',
        'unavailable'
      )
      return {
        revision: snapshot.revision,
        initialDigest: outputHex32(plain.initialDigest),
        value: object(plain.value, this.valueBytes)
      }
    } finally {
      if (bytes instanceof Uint8Array) bytes.fill(0)
    }
  }
  async read(): Promise<OperationStateSnapshot> {
    const { revision, value } = await this.decoded()
    return { revision, value }
  }
  async compareAndSwap(expected: string, input: OutputJSONObject): Promise<OperationStateResult> {
    const nextRevision = incrementOutputU64(expected),
      value = object(input, this.valueBytes)
    const before = await this.decoded()
    if (before.revision !== expected) return this.result(before, nextRevision, value)
    const envelope = await this.encode(nextRevision, before.initialDigest, value)
    const result = await this.base.compareAndSwap(expected, envelope)
    this.current()
    if (result.status === 'updated') {
      outputAssert(
        result.revision === nextRevision,
        'Protected operation CAS returned another revision',
        'unavailable'
      )
      return { status: 'updated', revision: result.revision }
    }
    return this.result(await this.decoded(), nextRevision, value)
  }
  private result(
    saved: Decoded,
    nextRevision: string,
    value: OutputJSONObject
  ): OperationStateResult {
    return {
      status:
        saved.revision === nextRevision &&
        canonicalOutputJSON(saved.value, { bytes: this.valueBytes }) ===
          canonicalOutputJSON(value, { bytes: this.valueBytes })
          ? 'replayed'
          : 'conflict',
      revision: saved.revision
    }
  }
  async close(): Promise<void> {
    if (this.closed) return
    this.current()
    this.closed = true
    await this.base.close()
  }
}
function pin<T extends object, Key extends keyof T>(port: T, key: Key): () => boolean {
  const method = port[key]
  outputAssert(typeof method === 'function', 'Protected operation capability must be callable')
  return () => port[key] === method
}
