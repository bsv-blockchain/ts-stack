import { LCH_LIMITS, LCH_MECHANISMS } from './constants.js'
import { lchAssert } from './errors.js'
import {
  normalizeSelection,
  selectionsIntersect,
  validateNormalizedSelection
} from './selection.js'
import { toHex } from './hash.js'
import { validateCriticalIdentifiers } from './objects.js'
import type { LCHValue, Selection } from './types.js'

export interface CompositionIngredient {
  sourceAssetId: Uint8Array
  sourceLicenseId: Uint8Array
  c2paIngredient: { url: string; alg?: string; hash: Uint8Array }
  relationship: 'componentOf' | 'inputTo'
  sourceSelection: Selection
  derivedSelection: Selection
  mappingProfile: string
  nextPolicy?: Record<string, LCHValue>
  settlementReceiptIds?: Uint8Array[]
  metadata?: Record<string, LCHValue>
}

export interface CompositionRecord {
  version: 1
  c2paManifestDigest: Uint8Array
  ingredients: CompositionIngredient[]
  critical?: string[]
}

export function validateCompositionRecord(
  record: CompositionRecord,
  supportedCriticalIdentifiers: ReadonlySet<string> = new Set()
): void {
  lchAssert(
    record !== null &&
      typeof record === 'object' &&
      record.version === 1 &&
      record.c2paManifestDigest instanceof Uint8Array &&
      record.c2paManifestDigest.length === 32 &&
      Array.isArray(record.ingredients) &&
      record.ingredients.length > 0 &&
      record.ingredients.length <= LCH_LIMITS.cborEntries,
    'ERR_LCH_PROVENANCE',
    'Composition record is invalid'
  )
  validateCriticalIdentifiers(
    record as unknown as Record<string, LCHValue>,
    supportedCriticalIdentifiers
  )
  record.ingredients.forEach(validateIngredient)
  const bindings = record.ingredients.map(ingredient => {
    const { url, alg, hash } = ingredient.c2paIngredient
    return JSON.stringify([url, alg ?? null, toHex(hash)])
  })
  lchAssert(
    new Set(bindings).size === bindings.length,
    'ERR_LCH_PROVENANCE',
    'Composition ingredients must bind distinct C2PA assertions'
  )
}

export function validateIngredient(ingredient: CompositionIngredient): void {
  lchAssert(
    ingredient !== null &&
      typeof ingredient === 'object' &&
      ingredient.sourceAssetId instanceof Uint8Array &&
      ingredient.sourceAssetId.length === 32 &&
      ingredient.sourceLicenseId instanceof Uint8Array &&
      ingredient.sourceLicenseId.length === 32,
    'ERR_LCH_PROVENANCE',
    'Composition IDs must be 32 bytes'
  )
  lchAssert(
    ingredient.c2paIngredient !== null &&
      typeof ingredient.c2paIngredient === 'object' &&
      typeof ingredient.c2paIngredient.url === 'string' &&
      ingredient.c2paIngredient.url.length > 0 &&
      ingredient.c2paIngredient.url.length <= 8192 &&
      !hasControlCharacter(ingredient.c2paIngredient.url) &&
      ingredient.c2paIngredient.hash instanceof Uint8Array &&
      ingredient.c2paIngredient.hash.length > 0 &&
      ingredient.c2paIngredient.hash.length <= 128 &&
      (ingredient.c2paIngredient.alg === undefined ||
        (typeof ingredient.c2paIngredient.alg === 'string' &&
          ingredient.c2paIngredient.alg.length > 0 &&
          ingredient.c2paIngredient.alg.length <= 128 &&
          !hasControlCharacter(ingredient.c2paIngredient.alg))),
    'ERR_LCH_PROVENANCE',
    'Composition C2PA hashed URI is invalid'
  )
  lchAssert(
    ingredient.relationship === 'componentOf' || ingredient.relationship === 'inputTo',
    'ERR_LCH_PROVENANCE',
    'Composition relationship is invalid'
  )
  lchAssert(
    ingredient.mappingProfile === LCH_MECHANISMS.wholePlacement,
    'ERR_LCH_PROFILE_UNSUPPORTED',
    'Unknown composition mapping profile'
  )
  lchAssert(
    ingredient.derivedSelection !== null && ingredient.derivedSelection?.type === 'all',
    'ERR_LCH_PROVENANCE',
    'Whole placement requires an all derived selection'
  )
  validateNormalizedSelection(ingredient.sourceSelection)
  if (ingredient.settlementReceiptIds !== undefined) {
    lchAssert(
      Array.isArray(ingredient.settlementReceiptIds) &&
        ingredient.settlementReceiptIds.length <= LCH_LIMITS.cborEntries &&
        ingredient.settlementReceiptIds.every(
          receiptId => receiptId instanceof Uint8Array && receiptId.length === 32
        ) &&
        new Set(ingredient.settlementReceiptIds.map(toHex)).size ===
          ingredient.settlementReceiptIds.length,
      'ERR_LCH_PROVENANCE',
      'Composition settlement Receipt IDs are invalid'
    )
  }
  for (const [value, name] of [
    [ingredient.nextPolicy, 'next Policy'],
    [ingredient.metadata, 'metadata']
  ] as const) {
    lchAssert(
      value === undefined ||
        (value !== null &&
          typeof value === 'object' &&
          !Array.isArray(value) &&
          !(value instanceof Uint8Array)),
      'ERR_LCH_PROVENANCE',
      `Composition ${name} is invalid`
    )
  }
}

function hasControlCharacter(value: string): boolean {
  for (const character of value) {
    const codePoint = character.codePointAt(0)!
    if (codePoint <= 0x1f || codePoint === 0x7f) return true
  }
  return false
}

export function activeIngredients(
  record: CompositionRecord,
  derivedSelection: Selection,
  supportedCriticalIdentifiers: ReadonlySet<string> = new Set()
): CompositionIngredient[] {
  validateCompositionRecord(record, supportedCriticalIdentifiers)
  return record.ingredients.filter(ingredient => {
    return selectionsIntersect(ingredient.derivedSelection, derivedSelection)
  })
}

export interface CompositionNode {
  assetId: Uint8Array
  selection: Selection
  record?: CompositionRecord
}

function traversalSelectionKey(selection: Selection): string {
  const normalized = normalizeSelection(selection)
  if (normalized.type === 'all') return 'all'
  if (normalized.type === 'media-fragment') return `media-fragment:${normalized.value}`
  return `${normalized.type}:${normalized.ranges
    .map(([start, end]) => `${BigInt(start)}-${BigInt(end)}`)
    .join(',')}`
}

export async function walkComposition(
  root: CompositionNode,
  load: (assetId: Uint8Array, selection: Selection) => Promise<CompositionNode | undefined>,
  maximumDepth = LCH_LIMITS.compositionDepth,
  supportedCriticalIdentifiers: ReadonlySet<string> = new Set()
): Promise<CompositionIngredient[]> {
  lchAssert(
    Number.isSafeInteger(maximumDepth) &&
      maximumDepth >= 0 &&
      maximumDepth <= LCH_LIMITS.compositionDepth,
    'ERR_LCH_CYCLE',
    'Composition depth limit is invalid'
  )
  const active = new Set<string>()
  const expanded = new Set<string>()
  const result: CompositionIngredient[] = []

  async function visit(node: CompositionNode, depth: number): Promise<void> {
    lchAssert(depth <= maximumDepth, 'ERR_LCH_CYCLE', 'Composition depth limit exceeded')
    lchAssert(node.assetId.length === 32, 'ERR_LCH_PROVENANCE', 'Composition Asset ID is invalid')
    validateNormalizedSelection(node.selection)
    const key = toHex(node.assetId)
    lchAssert(!active.has(key), 'ERR_LCH_CYCLE', 'Composition cycle detected')
    const expansionKey = `${key}\u0000${traversalSelectionKey(node.selection)}`
    if (expanded.has(expansionKey)) return
    active.add(key)
    if (node.record !== undefined) {
      for (const ingredient of activeIngredients(
        node.record,
        node.selection,
        supportedCriticalIdentifiers
      )) {
        lchAssert(
          result.length < LCH_LIMITS.cborEntries,
          'ERR_LCH_PROVENANCE',
          'Composition traversal limit exceeded'
        )
        result.push(ingredient)
        const source = await load(ingredient.sourceAssetId, ingredient.sourceSelection)
        if (source !== undefined) {
          lchAssert(
            toHex(source.assetId) === toHex(ingredient.sourceAssetId) &&
              traversalSelectionKey(source.selection) ===
                traversalSelectionKey(ingredient.sourceSelection),
            'ERR_LCH_PROVENANCE',
            'Composition loader returned a different Asset or Selection'
          )
          await visit(source, depth + 1)
        }
      }
    }
    active.delete(key)
    expanded.add(expansionKey)
  }

  await visit(root, 0)
  return result
}

export class LCHComposer {
  private readonly ingredients: CompositionIngredient[] = []

  constructor(private readonly c2paManifestDigest: Uint8Array) {}

  addWholePlacement(
    ingredient: Omit<CompositionIngredient, 'derivedSelection' | 'mappingProfile'>
  ): this {
    const complete: CompositionIngredient = {
      ...ingredient,
      derivedSelection: { type: 'all' },
      mappingProfile: LCH_MECHANISMS.wholePlacement
    }
    validateIngredient(complete)
    this.ingredients.push(complete)
    return this
  }

  build(): CompositionRecord {
    lchAssert(
      this.c2paManifestDigest.length === 32 && this.ingredients.length > 0,
      'ERR_LCH_PROVENANCE',
      'Composition record is incomplete'
    )
    const record: CompositionRecord = {
      version: 1,
      c2paManifestDigest: this.c2paManifestDigest.slice(),
      ingredients: [...this.ingredients]
    }
    validateCompositionRecord(record)
    return record
  }
}
