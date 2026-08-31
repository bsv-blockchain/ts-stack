import { LCH_AAD_PREFIX, LCH_KEY_ID_PREFIX, LCH_LIMITS, LCH_MECHANISMS } from './constants.js'
import { LCHError, lchAssert } from './errors.js'
import { concatBytes, sha256, toHex, uint64be } from './hash.js'
import type {
  EncryptionResult,
  KeyPeriod,
  SegmentedEncryptionDescriptor,
  Selection
} from './types.js'

const ALL_SELECTION: Selection = { type: 'all' }

export interface SegmentedEncryptionOptions {
  segmentSize?: number
  keyPeriodSegments?: number
  random?: (length: number) => Uint8Array
}

function secureRandom(length: number): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(length))
}

function ownedBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.slice().buffer
}

function toSafeNumber(value: number | bigint, name: string): number {
  const result = typeof value === 'bigint' ? Number(value) : value
  lchAssert(
    Number.isSafeInteger(result) && result >= 0,
    'ERR_LCH_KEY',
    `${name} is not a safe uint`
  )
  return result
}

export async function keyIdFor(cek: Uint8Array): Promise<Uint8Array> {
  lchAssert(cek.length === 32, 'ERR_LCH_KEY', 'CEK must contain 32 bytes')
  return sha256(concatBytes(LCH_KEY_ID_PREFIX, cek))
}

function periodFor(index: number, periods: readonly KeyPeriod[]): KeyPeriod {
  const period = periods.find(candidate => {
    const first = toSafeNumber(candidate.firstSegment, 'firstSegment')
    const count = toSafeNumber(candidate.segmentCount, 'segmentCount')
    return index >= first && index < first + count
  })
  if (period === undefined)
    throw new LCHError('ERR_LCH_KEY', `No key period covers segment ${index}`)
  return period
}

function segmentAad(
  descriptor: SegmentedEncryptionDescriptor,
  index: number,
  keyId: Uint8Array
): Uint8Array {
  return concatBytes(
    LCH_AAD_PREFIX,
    descriptor.encryptionId,
    uint64be(index),
    uint64be(descriptor.segmentCount),
    uint64be(descriptor.plaintextLength),
    keyId
  )
}

function segmentIv(prefix: Uint8Array, index: number): Uint8Array {
  lchAssert(prefix.length === 4, 'ERR_LCH_KEY', 'Nonce prefix must contain four bytes')
  return concatBytes(prefix, uint64be(index))
}

export function validateEncryptionDescriptor(descriptor: SegmentedEncryptionDescriptor): void {
  lchAssert(
    descriptor.algorithm === LCH_MECHANISMS.encryption,
    'ERR_LCH_KEY',
    'Unsupported encryption mechanism'
  )
  lchAssert(
    descriptor.encryptionId.length === 32,
    'ERR_LCH_KEY',
    'Encryption ID must contain 32 bytes'
  )
  lchAssert(
    descriptor.noncePrefix.length === 4,
    'ERR_LCH_KEY',
    'Nonce prefix must contain four bytes'
  )
  const plaintextLength = toSafeNumber(descriptor.plaintextLength, 'plaintextLength')
  const segmentSize = toSafeNumber(descriptor.segmentSize, 'segmentSize')
  const segmentCount = toSafeNumber(descriptor.segmentCount, 'segmentCount')
  lchAssert(
    segmentSize > 0 &&
      segmentCount > 0 &&
      segmentCount <= LCH_LIMITS.encryptionSegments &&
      descriptor.keyPeriods.length <= LCH_LIMITS.cborEntries,
    'ERR_LCH_KEY',
    'Segment size, count, or key-period count is invalid'
  )
  const expectedCount = Math.max(1, Math.ceil(plaintextLength / segmentSize))
  lchAssert(
    segmentCount === expectedCount,
    'ERR_LCH_KEY',
    'Segment count does not match plaintext length'
  )
  let cursor = 0
  for (const period of descriptor.keyPeriods) {
    const first = toSafeNumber(period.firstSegment, 'firstSegment')
    const count = toSafeNumber(period.segmentCount, 'key period segmentCount')
    lchAssert(
      period.keyId.length === 32 && count > 0 && first === cursor,
      'ERR_LCH_KEY',
      'Invalid key-period partition'
    )
    cursor += count
  }
  lchAssert(cursor === segmentCount, 'ERR_LCH_KEY', 'Key periods do not cover every segment')
}

export async function encryptSegmented(
  plaintext: Uint8Array,
  options: SegmentedEncryptionOptions = {}
): Promise<EncryptionResult> {
  const segmentSize = options.segmentSize ?? 4_194_288
  const segmentCount = Math.max(1, Math.ceil(plaintext.length / segmentSize))
  const keyPeriodSegments = options.keyPeriodSegments ?? segmentCount
  lchAssert(
    Number.isSafeInteger(segmentSize) &&
      segmentSize > 0 &&
      Number.isSafeInteger(keyPeriodSegments) &&
      keyPeriodSegments > 0,
    'ERR_LCH_KEY',
    'Segment and key-period sizes must be positive safe integers'
  )
  const random = options.random ?? secureRandom
  const descriptor: SegmentedEncryptionDescriptor = {
    algorithm: LCH_MECHANISMS.encryption,
    encryptionId: random(32),
    plaintextLength: plaintext.length,
    segmentSize,
    segmentCount,
    noncePrefix: random(4),
    keyPeriods: []
  }
  const keys = new Map<string, Uint8Array>()
  const keyMaterial = new Set<string>()
  for (let first = 0; first < segmentCount; first += keyPeriodSegments) {
    const cek = random(32)
    lchAssert(cek.length === 32, 'ERR_LCH_KEY', 'Random source returned an invalid CEK')
    const cekHex = toHex(cek)
    lchAssert(
      !keyMaterial.has(cekHex),
      'ERR_LCH_KEY',
      'Random source reused a CEK across key periods'
    )
    keyMaterial.add(cekHex)
    const keyId = await keyIdFor(cek)
    descriptor.keyPeriods.push({
      keyId,
      firstSegment: first,
      segmentCount: Math.min(keyPeriodSegments, segmentCount - first)
    })
    keys.set(toHex(keyId), cek)
  }
  validateEncryptionDescriptor(descriptor)
  const records: Uint8Array[] = []
  for (let index = 0; index < segmentCount; index += 1) {
    const period = periodFor(index, descriptor.keyPeriods)
    const cek = keys.get(toHex(period.keyId))
    lchAssert(cek !== undefined, 'ERR_LCH_KEY', 'Missing CEK during encryption')
    const key = await crypto.subtle.importKey('raw', ownedBuffer(cek), 'AES-GCM', false, [
      'encrypt'
    ])
    const segment = plaintext.slice(
      index * segmentSize,
      Math.min((index + 1) * segmentSize, plaintext.length)
    )
    const record = await crypto.subtle.encrypt(
      {
        name: 'AES-GCM',
        iv: ownedBuffer(segmentIv(descriptor.noncePrefix, index)),
        additionalData: ownedBuffer(segmentAad(descriptor, index, period.keyId)),
        tagLength: 128
      },
      key,
      ownedBuffer(segment)
    )
    records.push(new Uint8Array(record))
  }
  return { ciphertext: concatBytes(...records), descriptor, keys }
}

export function ciphertextLength(descriptor: SegmentedEncryptionDescriptor): bigint {
  return BigInt(descriptor.plaintextLength) + 16n * BigInt(descriptor.segmentCount)
}

export function recordRange(
  descriptor: SegmentedEncryptionDescriptor,
  index: number
): readonly [number, number] {
  validateEncryptionDescriptor(descriptor)
  const segmentSize = toSafeNumber(descriptor.segmentSize, 'segmentSize')
  const count = toSafeNumber(descriptor.segmentCount, 'segmentCount')
  lchAssert(index >= 0 && index < count, 'ERR_LCH_SELECTION', 'Segment index is out of range')
  const start = index * (segmentSize + 16)
  const plaintextLength = toSafeNumber(descriptor.plaintextLength, 'plaintextLength')
  const plainRecordLength =
    index === count - 1 ? plaintextLength - segmentSize * (count - 1) : segmentSize
  return [start, start + plainRecordLength + 16]
}

function selectedSegments(selection: Selection, count: number): Set<number> {
  if (selection.type === 'all') return new Set(Array.from({ length: count }, (_, index) => index))
  lchAssert(
    selection.type === 'segments',
    'ERR_LCH_SELECTION',
    'Decryption requires all or segment selection'
  )
  const result = new Set<number>()
  for (const [startValue, endValue] of selection.ranges) {
    const start = toSafeNumber(startValue, 'selection start')
    const end = toSafeNumber(endValue, 'selection end')
    lchAssert(start < end && end <= count, 'ERR_LCH_SELECTION', 'Segment selection is out of range')
    for (let index = start; index < end; index += 1) result.add(index)
  }
  return result
}

export function keyPeriodsForSelection(
  descriptor: SegmentedEncryptionDescriptor,
  selection: Selection
): KeyPeriod[] {
  validateEncryptionDescriptor(descriptor)
  const selected = selectedSegments(
    selection,
    toSafeNumber(descriptor.segmentCount, 'segmentCount')
  )
  return descriptor.keyPeriods.filter(period => {
    const first = toSafeNumber(period.firstSegment, 'firstSegment')
    const count = toSafeNumber(period.segmentCount, 'segmentCount')
    return Array.from(selected).some(index => index >= first && index < first + count)
  })
}

export function validateKeyGrantsForSelection(
  descriptor: SegmentedEncryptionDescriptor,
  selection: Selection,
  grants: ReadonlyArray<{ keyId: Uint8Array }>
): void {
  const expected = keyPeriodsForSelection(descriptor, selection).map(period => toHex(period.keyId))
  const actual = grants.map(grant => toHex(grant.keyId))
  lchAssert(
    new Set(actual).size === actual.length,
    'ERR_LCH_KEY',
    'License contains duplicate Key IDs'
  )
  lchAssert(
    expected.length === actual.length &&
      expected.every(keyId => actual.includes(keyId)) &&
      actual.every(keyId => expected.includes(keyId)),
    'ERR_LCH_KEY',
    'License must grant every and only the key periods intersecting its segment selection'
  )
}

export async function decryptSegmented(
  ciphertext: Uint8Array,
  descriptor: SegmentedEncryptionDescriptor,
  keys: ReadonlyMap<string, Uint8Array>,
  selection: Selection = ALL_SELECTION
): Promise<Uint8Array> {
  validateEncryptionDescriptor(descriptor)
  lchAssert(
    BigInt(ciphertext.length) === ciphertextLength(descriptor),
    'ERR_LCH_CONTENT_DIGEST',
    'Ciphertext length mismatch'
  )
  const count = toSafeNumber(descriptor.segmentCount, 'segmentCount')
  const selected = selectedSegments(selection, count)
  const plaintext: Uint8Array[] = []
  for (let index = 0; index < count; index += 1) {
    if (!selected.has(index)) continue
    const period = periodFor(index, descriptor.keyPeriods)
    const cek = keys.get(toHex(period.keyId))
    lchAssert(cek !== undefined, 'ERR_LCH_KEY', `No key grant for segment ${index}`)
    const actualKeyId = await keyIdFor(cek)
    lchAssert(
      toHex(actualKeyId) === toHex(period.keyId),
      'ERR_LCH_KEY',
      'CEK does not match its Key ID'
    )
    const [start, end] = recordRange(descriptor, index)
    const key = await crypto.subtle.importKey('raw', ownedBuffer(cek), 'AES-GCM', false, [
      'decrypt'
    ])
    try {
      const segment = await crypto.subtle.decrypt(
        {
          name: 'AES-GCM',
          iv: ownedBuffer(segmentIv(descriptor.noncePrefix, index)),
          additionalData: ownedBuffer(segmentAad(descriptor, index, period.keyId)),
          tagLength: 128
        },
        key,
        ownedBuffer(ciphertext.slice(start, end))
      )
      plaintext.push(new Uint8Array(segment))
    } catch (error) {
      throw new LCHError('ERR_LCH_AUTHENTICATION', `Segment ${index} failed authentication`, {
        cause: error
      })
    }
  }
  return concatBytes(...plaintext)
}
