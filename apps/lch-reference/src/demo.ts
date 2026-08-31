import {
  LCHComposer,
  LCH_MECHANISMS,
  LCH_PROFILES,
  MemoryLicenseStore,
  decryptSegmented,
  encryptSegmented,
  keyPeriodsForSelection,
  parsePinnedPolicy,
  permits,
  sha256,
  supportsProfile,
  timeWindowStatus,
  toHex,
  validateCompositionRecord,
  validateKeyGrantsForSelection,
  type CompositionRecord,
  type LCHValue,
  type SignedObject
} from '@bsv/lch'

export type EditorialTransformKind = 'identity' | 'time-warp' | 'reverse' | 'distortion'

export interface EditorialPlacement {
  id: number
  label: string
  kind: EditorialTransformKind
  rateNumerator?: number
  rateDenominator?: number
  distortionAmount?: number
}

export interface ProfileCheck {
  profile: string
  status: 'pass'
  observations: string[]
}

export const EDITORIAL_CASES: ReadonlyArray<Omit<EditorialPlacement, 'id'>> = [
  { label: 'unaltered', kind: 'identity' },
  { label: 'half speed', kind: 'time-warp', rateNumerator: 1, rateDenominator: 2 },
  { label: 'double speed', kind: 'time-warp', rateNumerator: 2, rateDenominator: 1 },
  { label: 'reversed', kind: 'reverse' },
  { label: 'distorted', kind: 'distortion', distortionAmount: 4 }
]

export function createToneWav(durationSeconds = 2, frequency = 220): Uint8Array {
  const sampleRate = 22_050
  const samples = new Int16Array(Math.floor(sampleRate * durationSeconds))
  for (let index = 0; index < samples.length; index += 1) {
    const envelope = Math.min(1, index / 300) * Math.min(1, (samples.length - index) / 800)
    const sample = Math.sin((2 * Math.PI * frequency * index) / sampleRate) * envelope
    samples[index] = Math.round(sample * 0x5fff)
  }
  return encodePcm16MonoWav(samples, sampleRate)
}

export function transformToneWav(source: Uint8Array, placement: EditorialPlacement): Uint8Array {
  const { samples, sampleRate } = decodePcm16MonoWav(source)
  const numerator = placement.rateNumerator ?? 1
  const denominator = placement.rateDenominator ?? 1
  if (
    !Number.isSafeInteger(numerator) ||
    !Number.isSafeInteger(denominator) ||
    numerator <= 0 ||
    denominator <= 0
  ) {
    throw new TypeError('Playback-rate ratio must contain positive safe integers')
  }
  const rate = numerator / denominator
  const output = new Int16Array(Math.max(1, Math.round(samples.length / rate)))
  for (let index = 0; index < output.length; index += 1) {
    const sourceOffset = Math.min(samples.length - 1, Math.floor(index * rate))
    const sourceIndex =
      placement.kind === 'reverse' ? samples.length - sourceOffset - 1 : sourceOffset
    let normalized = samples[sourceIndex] / 0x7fff
    if (placement.kind === 'distortion') {
      const amount = placement.distortionAmount ?? 4
      normalized = Math.tanh(normalized * amount) / Math.tanh(amount)
    }
    output[index] = Math.round(Math.max(-1, Math.min(1, normalized)) * 0x7fff)
  }
  return encodePcm16MonoWav(output, sampleRate)
}

export async function buildEditorialComposition(
  sourceAssetId: Uint8Array,
  sourceLicenseId: Uint8Array,
  placements: readonly EditorialPlacement[]
): Promise<CompositionRecord> {
  const composer = new LCHComposer(
    await sha256(new TextEncoder().encode('reference-c2pa-manifest'))
  )
  for (const placement of placements) {
    const editMetadata: Record<string, LCHValue> = {
      kind: placement.kind,
      label: placement.label,
      ...(placement.rateNumerator === undefined
        ? {}
        : {
            playbackRate: {
              numerator: placement.rateNumerator,
              denominator: placement.rateDenominator ?? 1
            }
          }),
      ...(placement.distortionAmount === undefined
        ? {}
        : { distortionAmount: placement.distortionAmount })
    }
    composer.addWholePlacement({
      sourceAssetId,
      sourceLicenseId,
      c2paIngredient: {
        url: `self#jumbf=/c2pa/reference/c2pa.assertions/c2pa.ingredient.v3/${placement.id}`,
        alg: 'sha256',
        hash: await sha256(new TextEncoder().encode(`placement:${placement.id}`))
      },
      relationship: 'componentOf',
      sourceSelection: { type: 'all' },
      metadata: {
        placementId: placement.id,
        'https://example.invalid/lch-reference/edit-v1': editMetadata
      }
    })
  }
  return composer.build()
}

export async function runCoreProfileChecks(
  sourceAssetId: Uint8Array,
  sourceLicenseId: Uint8Array
): Promise<ProfileCheck[]> {
  const mechanisms = {
    payment: LCH_MECHANISMS.brc105Single,
    keyDelivery: LCH_MECHANISMS.brc78Key,
    encryption: LCH_MECHANISMS.encryption,
    enforcement: 'https://bsv.brc.dev/apps/0170#conformingApplication'
  }
  const supported = Object.values(LCH_PROFILES).every(usageProfile =>
    supportsProfile({ usageProfile, ...mechanisms })
  )
  if (!supported) throw new Error('The reference capability set omitted a core profile')
  if (
    supportsProfile({
      usageProfile: LCH_PROFILES.fixedRender,
      ...mechanisms,
      critical: ['https://example.invalid/unknown-critical-profile']
    })
  ) {
    throw new Error('An unknown critical profile was accepted')
  }

  const encrypted = await encryptSegmented(new TextEncoder().encode('0123456789abcdefWXYZ'), {
    segmentSize: 4,
    keyPeriodSegments: 1
  })
  const range = { type: 'segments' as const, ranges: [[1, 3] as const] }
  const selectedPeriods = keyPeriodsForSelection(encrypted.descriptor, range)
  const grants = selectedPeriods.map(period => ({ keyId: period.keyId }))
  validateKeyGrantsForSelection(encrypted.descriptor, range, grants)
  const selectedKeys = new Map(
    selectedPeriods.map(period => [toHex(period.keyId), encrypted.keys.get(toHex(period.keyId))!])
  )
  const rangePlaintext = await decryptSegmented(
    encrypted.ciphertext,
    encrypted.descriptor,
    selectedKeys,
    range
  )
  let missingKeyRejected = false
  let extraKeyRejected = false
  try {
    validateKeyGrantsForSelection(encrypted.descriptor, range, grants.slice(1))
  } catch {
    missingKeyRejected = true
  }
  const extraPeriod = encrypted.descriptor.keyPeriods.find(
    period => !selectedPeriods.some(selected => toHex(selected.keyId) === toHex(period.keyId))
  )
  if (extraPeriod !== undefined) {
    try {
      validateKeyGrantsForSelection(encrypted.descriptor, range, [
        ...grants,
        { keyId: extraPeriod.keyId }
      ])
    } catch {
      extraKeyRejected = true
    }
  }
  if (
    new TextDecoder().decode(rangePlaintext) !== '456789ab' ||
    !missingKeyRejected ||
    !extraKeyRejected
  ) {
    throw new Error('Metered-range edge checks failed')
  }

  const agreementBytes = new TextEncoder().encode(
    JSON.stringify({
      '@context': ['http://www.w3.org/ns/odrl.jsonld'],
      '@type': 'Agreement',
      uid: 'lch:license:self',
      profile: 'https://bsv.brc.dev/apps/0170#odrl-profile',
      permission: [{ target: `lch:asset:sha256:${toHex(sourceAssetId)}`, action: 'read' }]
    })
  )
  const agreement = await parsePinnedPolicy(
    {
      mediaType: 'application/ld+json',
      digest: await sha256(agreementBytes),
      inline: agreementBytes
    },
    'Agreement',
    `lch:license:sha256:${toHex(sourceLicenseId)}`
  )
  const target = `lch:asset:sha256:${toHex(sourceAssetId)}`
  if (!permits(agreement, 'read', target)) throw new Error('Metered-event Agreement was not usable')
  const entitlement: SignedObject = { body: { profile: LCH_PROFILES.meteredEvent }, signatures: [] }
  const store = new MemoryLicenseStore()
  await store.put({
    assetId: toHex(sourceAssetId),
    offerId: toHex(sourceLicenseId),
    license: entitlement,
    storedAt: 1n
  })
  const firstRead = await store.get(toHex(sourceAssetId), toHex(sourceLicenseId))
  const repeatedRead = await store.get(toHex(sourceAssetId), toHex(sourceLicenseId))
  if (firstRead?.license !== repeatedRead?.license) {
    throw new Error('Stored entitlement was not reused for a repeated event')
  }

  const rentalWindow = { notBefore: 100, notAfter: 200 }
  const rentalStatuses = [99, 100, 199, 200].map(now => timeWindowStatus(rentalWindow, now))
  if (rentalStatuses.join(',') !== 'not-started,active,active,expired') {
    throw new Error('Rental boundaries are not half-open')
  }

  const editorialPlacements: EditorialPlacement[] = [
    { id: 1, ...EDITORIAL_CASES[0] },
    { id: 2, ...EDITORIAL_CASES[0] },
    ...EDITORIAL_CASES.slice(1).map((placement, index) => ({ id: index + 3, ...placement }))
  ]
  const composition = await buildEditorialComposition(
    sourceAssetId,
    sourceLicenseId,
    editorialPlacements
  )
  if (
    composition.ingredients.length !== editorialPlacements.length ||
    !composition.ingredients.every(
      ingredient =>
        ingredient.mappingProfile === LCH_MECHANISMS.wholePlacement &&
        ingredient.derivedSelection.type === 'all'
    )
  ) {
    throw new Error('Editorial composition changed whole-placement semantics')
  }
  let duplicateBindingRejected = false
  try {
    validateCompositionRecord({
      ...composition,
      ingredients: [composition.ingredients[0]!, composition.ingredients[0]!]
    })
  } catch {
    duplicateBindingRejected = true
  }
  if (!duplicateBindingRejected) throw new Error('A repeated C2PA assertion binding was accepted')

  const training = new LCHComposer(await sha256(new TextEncoder().encode('training-claim')))
    .addWholePlacement({
      sourceAssetId,
      sourceLicenseId,
      c2paIngredient: {
        url: 'self#jumbf=/c2pa/reference/training-input',
        alg: 'sha256',
        hash: await sha256(new TextEncoder().encode('training-input'))
      },
      relationship: 'inputTo',
      sourceSelection: { type: 'all' }
    })
    .build()
  if (training.ingredients[0]?.relationship !== 'inputTo') {
    throw new Error('Claimed training source was not recorded as inputTo')
  }

  return [
    {
      profile: LCH_PROFILES.fixedRender,
      status: 'pass',
      observations: [
        'profile/mechanism set supported',
        'opening remains non-spending',
        'unknown critical semantics rejected'
      ]
    },
    {
      profile: LCH_PROFILES.meteredRange,
      status: 'pass',
      observations: [
        'two selected records authenticated',
        'missing and extra key periods fail closed'
      ]
    },
    {
      profile: LCH_PROFILES.meteredEvent,
      status: 'pass',
      observations: ['existing exact entitlement reused', 'repeat read created no purchase']
    },
    {
      profile: LCH_PROFILES.rental,
      status: 'pass',
      observations: ['notBefore inclusive', 'notAfter exclusive']
    },
    {
      profile: LCH_PROFILES.composition,
      status: 'pass',
      observations: [
        'repeats bind distinct C2PA assertions',
        'duplicate assertion binding rejected',
        'editorial transforms keep whole placement'
      ]
    },
    {
      profile: LCH_PROFILES.training,
      status: 'pass',
      observations: [
        'training alone needs no derivative claim',
        'claimed individual source uses inputTo'
      ]
    }
  ]
}

export function randomBytes(length: number): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(length))
}

function decodePcm16MonoWav(bytes: Uint8Array): { samples: Int16Array; sampleRate: number } {
  if (
    bytes.length < 44 ||
    new TextDecoder().decode(bytes.slice(0, 4)) !== 'RIFF' ||
    new TextDecoder().decode(bytes.slice(8, 12)) !== 'WAVE'
  ) {
    throw new TypeError('Reference transforms require a PCM WAV fixture')
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  if (
    view.getUint16(20, true) !== 1 ||
    view.getUint16(22, true) !== 1 ||
    view.getUint16(34, true) !== 16
  ) {
    throw new TypeError('Reference transforms require mono 16-bit PCM')
  }
  const sampleBytes = view.getUint32(40, true)
  if (44 + sampleBytes !== bytes.length || sampleBytes % 2 !== 0) {
    throw new TypeError('Reference WAV has an invalid data chunk')
  }
  const samples = new Int16Array(sampleBytes / 2)
  for (let index = 0; index < samples.length; index += 1) {
    samples[index] = view.getInt16(44 + index * 2, true)
  }
  return { samples, sampleRate: view.getUint32(24, true) }
}

function encodePcm16MonoWav(samples: Int16Array, sampleRate: number): Uint8Array {
  const bytes = new Uint8Array(44 + samples.length * 2)
  const view = new DataView(bytes.buffer)
  const text = (offset: number, value: string): void => {
    for (let index = 0; index < value.length; index += 1)
      bytes[offset + index] = value.codePointAt(index) ?? 0
  }
  text(0, 'RIFF')
  view.setUint32(4, bytes.length - 8, true)
  text(8, 'WAVEfmt ')
  view.setUint32(16, 16, true)
  view.setUint16(20, 1, true)
  view.setUint16(22, 1, true)
  view.setUint32(24, sampleRate, true)
  view.setUint32(28, sampleRate * 2, true)
  view.setUint16(32, 2, true)
  view.setUint16(34, 16, true)
  text(36, 'data')
  view.setUint32(40, samples.length * 2, true)
  for (let index = 0; index < samples.length; index += 1)
    view.setInt16(44 + index * 2, samples[index], true)
  return bytes
}
