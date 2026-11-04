// BRC-207 action plan codec. Carried in action labels as
// `p color plan <partIndex> <partCount> <hexChunk>`; no wallet-toolbox dependency
// so applications can build plans with it.
import { toArray, toHex } from '@bsv/sdk/primitives/utils'
import {
  colorProtocolID,
  ISSUE,
  parseAssetId,
  parseAssetSelector,
  parseOutpoint,
  validateIdentityKey,
  validateRemittanceString
} from './identifiers.js'
import {
  exactMembers,
  jsonArray,
  jsonObject,
  jsonUint32,
  parseStrictJsonBytes,
  type JsonObject,
  type JsonValue
} from './strictJson.js'

export const COLOR_PLAN_LABEL_PREFIX = 'p color plan '

const CHUNK_HEX_LENGTH = 200
const MAX_PLAN_BYTES = 16 * 1024 * 1024
// Bounds the label count before reassembly; the joined hex is then bounded exactly.
const MAX_PLAN_PARTS = Math.ceil((MAX_PLAN_BYTES * 2) / CHUNK_HEX_LENGTH)
const PLAN_LABEL = /^p color plan (0|[1-9]\d{0,9}) ([1-9]\d{0,9}) ([0-9a-f]+)$/

export const COLOR_OPERATIONS = [
  'transfer',
  'burn',
  'deploy-fixed',
  'deploy-authority',
  'mint',
  'authority-split',
  'authority-combine',
  'authority-transfer',
  'authority-end',
  'resource'
] as const

export type ColorOperationName = (typeof COLOR_OPERATIONS)[number]

/** Key derivation facts for a managed output; `assetId` is `ISSUE` for a deploy output. */
export interface ColorRemittance {
  outputIndex: number
  assetId: string
  derivationPrefix: string
  derivationSuffix: string
  senderIdentityKey: string
}

export interface ColorOperation {
  assetId: string
  operation: ColorOperationName
}

/** A BRC-207 version 1 action plan. */
export interface ColorPlan {
  version: 1
  assets: string[]
  ownedOutputs: ColorRemittance[]
  operations: ColorOperation[]
  inputPositions: Array<{ outpoint: string; index: number }>
  changePositions: Array<{ assetId: string | null; index: number }>
  sighashTypes: Array<{ outpoint: string; sighashType: number }>
  profileData?: Record<string, Record<string, JsonValue>>
}

function unique<T>(values: T[], label: string): void {
  if (new Set(values).size !== values.length) throw new Error(`BRC-207: duplicate ${label}`)
}

/** Validates a remittance object, as used by plans and signature envelopes. */
export function parseRemittance(value: JsonValue, label: string): ColorRemittance {
  const object = jsonObject(value, label)
  exactMembers(
    object,
    ['outputIndex', 'assetId', 'derivationPrefix', 'derivationSuffix', 'senderIdentityKey'],
    [],
    label
  )
  const remittance: ColorRemittance = {
    outputIndex: jsonUint32(object.outputIndex, `${label}.outputIndex`),
    assetId: parseAssetSelector(object.assetId),
    derivationPrefix: validateRemittanceString(
      object.derivationPrefix,
      `${label}.derivationPrefix`
    ),
    derivationSuffix: validateRemittanceString(
      object.derivationSuffix,
      `${label}.derivationSuffix`
    ),
    senderIdentityKey: validateIdentityKey(object.senderIdentityKey, `${label}.senderIdentityKey`)
  }
  colorProtocolID(remittance.assetId, remittance.derivationPrefix, remittance.derivationSuffix)
  return remittance
}

/** Validates a remittance list: at most one remittance per output index. */
export function parseRemittances(value: JsonValue | undefined, label: string): ColorRemittance[] {
  const remittances = jsonArray(value, label).map((item, i) =>
    parseRemittance(item, `${label}[${i}]`)
  )
  unique(
    remittances.map(remittance => remittance.outputIndex),
    `${label} output index`
  )
  return remittances
}

/** Validates optional `profileData`: profile identifier, then asset ID or `ISSUE`, then profile data. */
export function parseProfileData(
  value: JsonValue | undefined,
  label: string
): Record<string, Record<string, JsonValue>> | undefined {
  if (value === undefined) return undefined
  const profiles = jsonObject(value, label)
  const result: Record<string, Record<string, JsonValue>> = Object.create(null)
  for (const [profile, assets] of Object.entries(profiles)) {
    const byAsset = jsonObject(assets, `${label}.${profile}`)
    for (const assetId of Object.keys(byAsset)) parseAssetSelector(assetId)
    result[profile] = { ...byAsset }
  }
  return result
}

function parsePlan(value: JsonValue): ColorPlan {
  const object: JsonObject = jsonObject(value, 'plan')
  exactMembers(
    object,
    [
      'version',
      'assets',
      'ownedOutputs',
      'operations',
      'inputPositions',
      'changePositions',
      'sighashTypes'
    ],
    ['profileData'],
    'plan'
  )
  if (object.version !== 1) throw new Error('BRC-207: plan version must be 1')
  const assets = jsonArray(object.assets, 'plan.assets').map(asset => parseAssetSelector(asset))
  unique(assets, 'plan asset')
  const operations = jsonArray(object.operations, 'plan.operations').map((item, i) => {
    const operation = jsonObject(item, `plan.operations[${i}]`)
    exactMembers(operation, ['assetId', 'operation'], [], `plan.operations[${i}]`)
    if (!COLOR_OPERATIONS.includes(operation.operation as ColorOperationName)) {
      throw new Error(`BRC-207: plan.operations[${i}] has an unknown operation`)
    }
    return {
      assetId: parseAssetSelector(operation.assetId),
      operation: operation.operation as ColorOperationName
    }
  })
  unique(
    operations.map(operation => `${operation.assetId} ${operation.operation}`),
    'plan operation'
  )
  const inputPositions = jsonArray(object.inputPositions, 'plan.inputPositions').map((item, i) => {
    const position = jsonObject(item, `plan.inputPositions[${i}]`)
    exactMembers(position, ['outpoint', 'index'], [], `plan.inputPositions[${i}]`)
    parseOutpoint(position.outpoint)
    return {
      outpoint: position.outpoint as string,
      index: jsonUint32(position.index, `plan.inputPositions[${i}].index`)
    }
  })
  unique(
    inputPositions.map(position => position.outpoint),
    'plan input position outpoint'
  )
  unique(
    inputPositions.map(position => position.index),
    'plan input position index'
  )
  const changePositions = jsonArray(object.changePositions, 'plan.changePositions').map(
    (item, i) => {
      const position = jsonObject(item, `plan.changePositions[${i}]`)
      exactMembers(position, ['assetId', 'index'], [], `plan.changePositions[${i}]`)
      if (position.assetId !== null) parseAssetId(position.assetId)
      return {
        assetId: position.assetId as string | null,
        index: jsonUint32(position.index, `plan.changePositions[${i}].index`)
      }
    }
  )
  unique(
    changePositions.map(position => position.assetId),
    'plan change position asset'
  )
  unique(
    changePositions.map(position => position.index),
    'plan change position index'
  )
  const sighashTypes = jsonArray(object.sighashTypes, 'plan.sighashTypes').map((item, i) => {
    const override = jsonObject(item, `plan.sighashTypes[${i}]`)
    exactMembers(override, ['outpoint', 'sighashType'], [], `plan.sighashTypes[${i}]`)
    parseOutpoint(override.outpoint)
    const sighashType = jsonUint32(override.sighashType, `plan.sighashTypes[${i}].sighashType`)
    if (sighashType > 255)
      throw new Error(`BRC-207: plan.sighashTypes[${i}].sighashType must be in 0..255`)
    return { outpoint: override.outpoint as string, sighashType }
  })
  unique(
    sighashTypes.map(override => override.outpoint),
    'plan sighash override outpoint'
  )
  const plan: ColorPlan = {
    version: 1,
    assets,
    ownedOutputs: parseRemittances(object.ownedOutputs, 'plan.ownedOutputs'),
    operations,
    inputPositions,
    changePositions,
    sighashTypes
  }
  const profileData = parseProfileData(object.profileData, 'plan.profileData')
  if (profileData !== undefined) plan.profileData = profileData
  const referenced = [
    ...plan.ownedOutputs.map(remittance => remittance.assetId),
    ...plan.operations.map(operation => operation.assetId),
    ...plan.changePositions.flatMap(position =>
      position.assetId === null ? [] : [position.assetId]
    )
  ]
  for (const assetId of referenced) {
    if (!assets.includes(assetId))
      throw new Error(`BRC-207: plan references ${assetId} outside plan.assets`)
  }
  if (
    assets.includes(ISSUE) &&
    plan.operations.filter(op => op.operation.startsWith('deploy-')).length !== 1
  ) {
    throw new Error('BRC-207: a deploy plan has exactly one deploy operation')
  }
  return plan
}

/** Every chunk is whole hex bytes; every chunk but the last fills its label. */
function assertPlanChunk(hex: string, index: number, count: number): void {
  if (hex.length % 2 !== 0 || hex.length > CHUNK_HEX_LENGTH)
    throw new Error('BRC-207: invalid plan chunk')
  if (index < count - 1 && hex.length !== CHUNK_HEX_LENGTH)
    throw new Error('BRC-207: short nonfinal plan chunk')
}

/** Encodes and decodes BRC-207 action plans as `p color plan` labels. */
export const ColorPlan = {
  /** Splits a plan into `p color plan <i> <n> <hex>` labels after validating it. */
  toLabels(plan: ColorPlan): string[] {
    const bytes = toArray(JSON.stringify(plan), 'utf8')
    if (bytes.length > MAX_PLAN_BYTES) throw new Error('BRC-207: plan exceeds 16 MiB')
    parsePlan(parseStrictJsonBytes(bytes, 'plan'))
    const hex = toHex(bytes)
    const count = Math.ceil(hex.length / CHUNK_HEX_LENGTH)
    return Array.from(
      { length: count },
      (_, i) =>
        `${COLOR_PLAN_LABEL_PREFIX}${i} ${count} ${hex.slice(i * CHUNK_HEX_LENGTH, (i + 1) * CHUNK_HEX_LENGTH)}`
    )
  },

  /** Reassembles the plan from its labels; undefined when no plan labels are present. */
  fromLabels(labels: readonly string[] | undefined): ColorPlan | undefined {
    const parts = (labels ?? []).filter(label => label.startsWith(COLOR_PLAN_LABEL_PREFIX))
    if (parts.length === 0) return undefined
    let count: number | undefined
    const chunks: string[] = []
    for (const label of parts) {
      const match = PLAN_LABEL.exec(label)
      if (match == null) throw new Error('BRC-207: invalid p color plan label')
      const index = Number(match[1])
      const partCount = Number(match[2])
      const hex = match[3]
      if (partCount > MAX_PLAN_PARTS) throw new Error('BRC-207: plan exceeds 16 MiB')
      if (count !== undefined && count !== partCount)
        throw new Error('BRC-207: inconsistent plan part counts')
      count = partCount
      if (index >= partCount) throw new Error('BRC-207: plan part index out of range')
      if (chunks[index] !== undefined) throw new Error('BRC-207: duplicate plan part')
      assertPlanChunk(hex, index, partCount)
      chunks[index] = hex
    }
    if (count === undefined || parts.length !== count) throw new Error('BRC-207: missing plan part')
    const hex = chunks.join('')
    if (hex.length > MAX_PLAN_BYTES * 2) throw new Error('BRC-207: plan exceeds 16 MiB')
    return parsePlan(parseStrictJsonBytes(toArray(hex, 'hex'), 'plan'))
  }
}
