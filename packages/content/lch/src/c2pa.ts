import { lchAssert } from './errors.js'
import { sha256, toHex } from './hash.js'
import type { C2PAAdapter, C2PAIngredientBinding } from './types.js'
import { validateCompositionRecord, type CompositionRecord } from './composition.js'

export async function validateC2PAComposition(
  asset: Uint8Array,
  manifest: Uint8Array | undefined,
  record: CompositionRecord,
  adapter: C2PAAdapter,
  supportedCriticalIdentifiers: ReadonlySet<string> = new Set()
): Promise<void> {
  validateCompositionRecord(record, supportedCriticalIdentifiers)
  if (manifest !== undefined) {
    lchAssert(
      toHex(await sha256(manifest)) === toHex(record.c2paManifestDigest),
      'ERR_LCH_PROVENANCE',
      'C2PA Manifest digest does not match the Composition Record'
    )
  }
  const bindings = await adapter.validate(asset, manifest)
  lchAssert(
    Array.isArray(bindings) && bindings.length === record.ingredients.length,
    'ERR_LCH_PROVENANCE',
    'Composition record and C2PA ingredient sets differ'
  )
  const expected = new Set(
    record.ingredients.map(ingredient =>
      bindingKey({
        sourceAssetId: ingredient.sourceAssetId,
        relationship: ingredient.relationship,
        hashedUri: ingredient.c2paIngredient
      })
    )
  )
  const actual = bindings.map(bindingKey)
  lchAssert(
    new Set(actual).size === actual.length &&
      actual.every(binding => expected.has(binding)) &&
      expected.size === actual.length,
    'ERR_LCH_PROVENANCE',
    'Composition record and C2PA ingredient sets differ'
  )
}

function bindingKey(binding: C2PAIngredientBinding): string {
  lchAssert(
    binding !== null &&
      typeof binding === 'object' &&
      binding.sourceAssetId instanceof Uint8Array &&
      binding.sourceAssetId.length === 32 &&
      (binding.relationship === 'componentOf' || binding.relationship === 'inputTo') &&
      binding.hashedUri !== null &&
      typeof binding.hashedUri === 'object' &&
      typeof binding.hashedUri.url === 'string' &&
      binding.hashedUri.url.length > 0 &&
      binding.hashedUri.url.length <= 8192 &&
      !hasControlCharacter(binding.hashedUri.url) &&
      (binding.hashedUri.alg === undefined ||
        (typeof binding.hashedUri.alg === 'string' &&
          binding.hashedUri.alg.length > 0 &&
          binding.hashedUri.alg.length <= 128 &&
          !hasControlCharacter(binding.hashedUri.alg))) &&
      binding.hashedUri.hash instanceof Uint8Array &&
      binding.hashedUri.hash.length > 0 &&
      binding.hashedUri.hash.length <= 128,
    'ERR_LCH_PROVENANCE',
    'C2PA ingredient binding is invalid'
  )
  return JSON.stringify([
    toHex(binding.sourceAssetId),
    binding.relationship,
    binding.hashedUri.url,
    binding.hashedUri.alg ?? null,
    toHex(binding.hashedUri.hash)
  ])
}

function hasControlCharacter(value: string): boolean {
  for (const character of value) {
    const codePoint = character.codePointAt(0)!
    if (codePoint <= 0x1f || codePoint === 0x7f) return true
  }
  return false
}

export class StaticC2PAAdapter implements C2PAAdapter {
  constructor(private readonly bindings: C2PAIngredientBinding[]) {}

  async validate(): Promise<C2PAIngredientBinding[]> {
    return this.bindings
  }
}
