import { awaitFromSync, awaitVoidFromSync } from '../../utility/promiseFromSync'
import {
  Brc38SemanticStage,
  type Brc38SemanticStageOptions,
  type Brc38StageStore,
  type Brc38StageRecord,
  type Brc38StageTable
} from './Brc38SemanticStage'
import type { Brc38JsonStreamedRow, Brc38JsonStreamedField } from './Brc38JsonBinaryFields'
import { brc38JsonBinaryField } from './Brc38JsonBinaryFields'
import { brc38JsonStructuredField, type Brc38JsonStructuredField } from './Brc38JsonStructuredFields'
import type { Brc38PrivateStructuredPolicy } from './Brc38PrivateStructuredPolicy'
import {
  brc38PrivateIdbStructuredPolicy,
  type Brc38PrivateIdbStructuredPolicy
} from './Brc38PrivateIdbStructuredPolicy'
import { brc38JsonTextField, type Brc38JsonTextField } from './Brc38JsonTextFields'
import type { BRC38WalletData } from './index'
import type { PortableRow } from './Brc38PortableRows'

export interface Brc38StreamedStageStore extends Brc38StageStore {
  appendStreamed: (
    record: Brc38StageRecord,
    descriptors: Brc38JsonStreamedRow['binaries'],
    structured?: NonNullable<Brc38JsonStreamedRow['structured']>,
    texts?: NonNullable<Brc38JsonStreamedRow['texts']>
  ) => Promise<void>
  validateTextFields?: (
    table: Brc38StageTable,
    index: number,
    descriptors: NonNullable<Brc38JsonStreamedRow['texts']>
  ) => Promise<void>
  streamedRow: (table: Brc38StageTable, index: number) => Promise<Brc38JsonStreamedRow | undefined>
  validateStructuredFields?: (
    table: Brc38StageTable,
    index: number,
    descriptors: NonNullable<Brc38JsonStreamedRow['structured']>,
    policy: Brc38PrivateStructuredPolicy
  ) => Promise<void>
  validateIdbStructuredFields?: (
    table: Brc38StageTable,
    index: number,
    descriptors: NonNullable<Brc38JsonStreamedRow['structured']>,
    policy: Brc38PrivateIdbStructuredPolicy
  ) => Promise<void>
  sealStreamed: Brc38StageStore['seal']
}
/** A bounded validation view supplies only binary presence/type to the unchanged
 * semantic rules. Structured presence is supplied only AFTER freshly validating
 * all actual visible values using the owned source and external index. Actual
 * content/digest belong to the real field store and are freshly reverified.
 * Empty values in this view are
 * NEVER persisted, exposed as a full wallet row or handed to a legacy receiver. */
function validationView(table: Brc38StageTable, row: Brc38JsonStreamedRow): PortableRow {
  const result: PortableRow = { ...row.fields }
  const names = Object.keys(row.binaries)
  if (names.length > 3) throw new Error('Too many staged binary field descriptors')
  for (const field of names) {
    const value = row.binaries[field]
    if (
      !brc38JsonBinaryField(table, field) ||
      Object.hasOwn(result, field) ||
      value.field !== field ||
      value.encoding !== (field === 'noSendExpiryReclaimRawTx' ? 'number-array' : 'base64') ||
      !Number.isSafeInteger(value.bytes) ||
      value.bytes < 0 ||
      !/^[0-9a-f]{64}$/.test(value.sha256)
    )
      throw new Error('Invalid field-aware private semantic row')
    result[field] = value.encoding === 'base64' ? '' : []
  }
  const json = row.structured ?? {},
    jsonNames = Object.keys(json)
  if (jsonNames.length > 3) throw new Error('Too many staged structured field descriptors')
  for (const field of jsonNames) {
    const value = json[field]
    if (
      !brc38JsonStructuredField(table, field) ||
      Object.hasOwn(result, field) ||
      value.field !== field ||
      value.encoding !== 'utf8-json' ||
      !Number.isSafeInteger(value.bytes) ||
      value.bytes < 2 ||
      value.bytes > 1000000000 ||
      !/^[0-9a-f]{64}$/.test(value.sha256)
    )
      throw new Error('Invalid structured private semantic row')
    result[field] = Object.freeze({})
  }
  const texts = row.texts ?? {},
    textNames = Object.keys(texts)
  if (textNames.length > 7) throw new Error('Too many staged scalar TEXT descriptors')
  for (const field of textNames) {
    const value = texts[field]
    if (
      !brc38JsonTextField(table, field) ||
      Object.hasOwn(result, field) ||
      value.field !== field ||
      value.encoding !== 'utf8' ||
      !Number.isSafeInteger(value.bytes) ||
      value.bytes < 0 ||
      value.bytes > 1000000000 ||
      !/^[0-9a-f]{64}$/.test(value.sha256)
    )
      throw new Error('Invalid scalar TEXT private semantic row')
  }
  // Actual separately staged string content supplies its type. Do not fabricate
  // an empty value or persist a partial wallet DTO as a complete row.
  return result
}
function detach(row: Brc38JsonStreamedRow): Brc38JsonStreamedRow {
  const binaries: Record<string, Brc38JsonStreamedField> = Object.create(null)
  const structured: Record<string, Brc38JsonStructuredField> = Object.create(null),
    texts: Record<string, Brc38JsonTextField> = Object.create(null)
  if (Object.keys(row.binaries).length > 3) throw new Error('Too many staged binary field descriptors')
  for (const [field, value] of Object.entries(row.binaries))
    binaries[field] = Object.freeze({
      field: value.field,
      encoding: value.encoding,
      bytes: value.bytes,
      sha256: value.sha256
    })
  if (Object.keys(row.structured ?? {}).length > 3) throw new Error('Too many staged structured field descriptors')
  for (const [field, value] of Object.entries(row.structured ?? {}))
    structured[field] = Object.freeze({
      field: value.field,
      encoding: value.encoding,
      bytes: value.bytes,
      sha256: value.sha256
    })
  if (Object.keys(row.texts ?? {}).length > 7) throw new Error('Too many staged scalar TEXT descriptors')
  for (const [field, value] of Object.entries(row.texts ?? {}))
    texts[field] = Object.freeze({
      field: value.field,
      encoding: value.encoding,
      bytes: value.bytes,
      sha256: value.sha256
    })
  // Metadata is already frozen/bounded by the parser. Copy its field dictionary
  // so no caller can replace presence fields across the first awaited write.
  return Object.freeze({
    fields: Object.freeze({ ...row.fields }),
    binaries: Object.freeze(binaries),
    ...(Object.keys(structured).length === 0 ? {} : { structured: Object.freeze(structured) }),
    ...(Object.keys(texts).length === 0 ? {} : { texts: Object.freeze(texts) })
  })
}

/** Reuses all original thirteen-table semantic/unique/relationship/profile and
 * provenance checks; only the private store's physical field representation
 * differs. Successful semantic sealing still cannot activate a native import. */
export class Brc38StreamedSemanticStage {
  private readonly semantic: Brc38SemanticStage
  private readonly structuredPolicy?: Readonly<Brc38PrivateStructuredPolicy>
  private readonly idbStructuredPolicy?: Readonly<Brc38PrivateIdbStructuredPolicy>
  private pending?: { table: Brc38StageTable; index: number; row: Brc38JsonStreamedRow }
  constructor(
    readonly store: Brc38StreamedStageStore,
    options: Brc38SemanticStageOptions,
    structuredPolicy?: Brc38PrivateStructuredPolicy,
    idbStructuredPolicy?: Brc38PrivateIdbStructuredPolicy
  ) {
    if (structuredPolicy !== undefined && idbStructuredPolicy !== undefined)
      throw new RangeError('Select one actual structured staging backend')
    this.idbStructuredPolicy =
      idbStructuredPolicy === undefined ? undefined : brc38PrivateIdbStructuredPolicy(idbStructuredPolicy)
    this.structuredPolicy =
      structuredPolicy === undefined
        ? undefined
        : Object.freeze({
            privateIndexParent: structuredPolicy.privateIndexParent,
            maximumTemporaryIndexBytes: structuredPolicy.maximumTemporaryIndexBytes,
            maximumIndexMembers: structuredPolicy.maximumIndexMembers,
            maximumStructuredBytes: structuredPolicy.maximumStructuredBytes,
            maximumCanonicalBytes: structuredPolicy.maximumCanonicalBytes,
            maximumReadBytes: structuredPolicy.maximumReadBytes,
            maximumIndexAllocationBytes: structuredPolicy.maximumIndexAllocationBytes,
            maximumGrammarAllocationBytes: structuredPolicy.maximumGrammarAllocationBytes,
            workingAllocation: structuredPolicy.workingAllocation,
            signal: structuredPolicy.signal
          })
    const bridge: Brc38StageStore = {
      append: async record => {
        const pending = this.pending
        if (pending === undefined || pending.table !== record.table || pending.index !== record.index)
          throw new Error('Field-aware semantic append lost its exact provisional row')
        await store.appendStreamed(
          { ...record, row: pending.row.fields },
          pending.row.binaries,
          pending.row.structured,
          pending.row.texts
        )
      },
      count: table => awaitFromSync(() => store.count(table)),
      row: async (table, index) => {
        const actual = await store.streamedRow(table, index)
        return actual === undefined ? undefined : await this.checkedView(table, index, detach(actual))
      },
      textFields: async (table, index) => {
        const actual = await store.streamedRow(table, index)
        if (actual === undefined) throw new Error('Scalar TEXT semantic replay row is absent')
        const detached = detach(actual)
        validationView(table, detached)
        await this.checkedTexts(table, index, detached)
        return Object.freeze(Object.keys(detached.texts ?? {}))
      },
      has: (namespace, key) => awaitFromSync(() => store.has(namespace, key)),
      seal: (header, counts) => awaitFromSync(() => store.sealStreamed(header, counts)),
      discard: cause => awaitFromSync(() => store.discard(cause))
    }
    this.semantic = new Brc38SemanticStage(bridge, options)
  }
  private async checkedTexts(table: Brc38StageTable, index: number, row: Brc38JsonStreamedRow): Promise<void> {
    if (Object.keys(row.texts ?? {}).length === 0) return
    if (typeof this.store.validateTextFields !== 'function')
      throw new Error('Scalar TEXT requires its actual private content validator')
    await this.store.validateTextFields(table, index, row.texts!)
  }
  private async checkedView(table: Brc38StageTable, index: number, row: Brc38JsonStreamedRow): Promise<PortableRow> {
    // Validate coordinates/presence before passing data to the real host.
    const view = validationView(table, row)
    await this.checkedTexts(table, index, row)
    if (Object.keys(row.structured ?? {}).length !== 0) {
      if (this.idbStructuredPolicy !== undefined) {
        if (typeof this.store.validateIdbStructuredFields !== 'function')
          throw new Error('Browser structured fields require their actual private indexed source')
        await this.store.validateIdbStructuredFields(table, index, row.structured!, this.idbStructuredPolicy)
      } else {
        if (this.structuredPolicy === undefined || typeof this.store.validateStructuredFields !== 'function')
          throw new Error('Structured private fields require the actual indexed semantic source and explicit policy')
        await this.store.validateStructuredFields(table, index, row.structured!, this.structuredPolicy)
      }
    }
    return view
  }
  async provisionalRow(table: Brc38StageTable, index: number, input: Brc38JsonStreamedRow): Promise<void> {
    if (this.pending !== undefined) throw new Error('Field-aware semantic staging already owns a row')
    const row = detach(input)
    this.pending = { table, index, row }
    try {
      const view = await this.checkedView(table, index, row)
      await this.semantic.provisionalRow(table, index, view, Object.freeze(Object.keys(row.texts ?? {})))
    } finally {
      this.pending = undefined
    }
  }
  async validateCompleted(
    header: Readonly<BRC38WalletData>,
    counts: Readonly<Record<Brc38StageTable, number>>
  ): Promise<void> {
    if (this.pending !== undefined) throw new Error('Field-aware semantic staging still owns a provisional row')
    await this.semantic.validateCompleted(header, counts)
  }
  discard(cause: unknown): Promise<void> {
    return awaitVoidFromSync(() => this.semantic.discard(cause))
  }
}
