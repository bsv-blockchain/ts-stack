import { LCH_LIMITS, LCH_MECHANISMS } from './constants.js'
import { lchAssert } from './errors.js'
import { selectionsIntersect, validateNormalizedSelection } from './selection.js'
import { toHex } from './hash.js'
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

export function validateCompositionRecord(record: CompositionRecord): void {
  lchAssert(
    record.version === 1 &&
      record.c2paManifestDigest.length === 32 &&
      record.ingredients.length > 0 &&
      record.ingredients.length <= LCH_LIMITS.cborEntries,
    'ERR_LCH_PROVENANCE',
    'Composition record is invalid'
  )
  record.ingredients.forEach(validateIngredient)
  const bindings = record.ingredients.map(ingredient => {
    const { url, alg, hash } = ingredient.c2paIngredient
    return `${url}\u0000${alg ?? ''}\u0000${toHex(hash)}`
  })
  lchAssert(
    new Set(bindings).size === bindings.length,
    'ERR_LCH_PROVENANCE',
    'Composition ingredients must bind distinct C2PA assertions'
  )
}

export function validateIngredient(ingredient: CompositionIngredient): void {
  lchAssert(
    ingredient.sourceAssetId.length === 32 && ingredient.sourceLicenseId.length === 32,
    'ERR_LCH_PROVENANCE',
    'Composition IDs must be 32 bytes'
  )
  lchAssert(
    ingredient.c2paIngredient.url.length > 0 &&
      ingredient.c2paIngredient.hash.length > 0 &&
      (ingredient.c2paIngredient.alg === undefined || ingredient.c2paIngredient.alg.length > 0),
    'ERR_LCH_PROVENANCE',
    'Composition C2PA hashed URI is invalid'
  )
  lchAssert(
    ingredient.mappingProfile === LCH_MECHANISMS.wholePlacement,
    'ERR_LCH_PROFILE_UNSUPPORTED',
    'Unknown composition mapping profile'
  )
  lchAssert(
    ingredient.derivedSelection.type === 'all',
    'ERR_LCH_PROVENANCE',
    'Whole placement requires an all derived selection'
  )
  validateNormalizedSelection(ingredient.sourceSelection)
}

export function activeIngredients(
  record: CompositionRecord,
  derivedSelection: Selection
): CompositionIngredient[] {
  validateCompositionRecord(record)
  return record.ingredients.filter(ingredient => {
    return selectionsIntersect(ingredient.derivedSelection, derivedSelection)
  })
}

export interface CompositionNode {
  assetId: Uint8Array
  selection: Selection
  record?: CompositionRecord
}

export async function walkComposition(
  root: CompositionNode,
  load: (assetId: Uint8Array, selection: Selection) => Promise<CompositionNode | undefined>,
  maximumDepth = LCH_LIMITS.compositionDepth
): Promise<CompositionIngredient[]> {
  const active = new Set<string>()
  const result: CompositionIngredient[] = []

  async function visit(node: CompositionNode, depth: number): Promise<void> {
    lchAssert(depth <= maximumDepth, 'ERR_LCH_CYCLE', 'Composition depth limit exceeded')
    const key = toHex(node.assetId)
    lchAssert(!active.has(key), 'ERR_LCH_CYCLE', 'Composition cycle detected')
    active.add(key)
    if (node.record !== undefined) {
      for (const ingredient of activeIngredients(node.record, node.selection)) {
        result.push(ingredient)
        const source = await load(ingredient.sourceAssetId, ingredient.sourceSelection)
        if (source !== undefined) await visit(source, depth + 1)
      }
    }
    active.delete(key)
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
