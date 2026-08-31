import { lchAssert } from './errors.js'
import { sha256, toHex } from './hash.js'
import type { C2PAAdapter, C2PAIngredientBinding } from './types.js'
import { validateCompositionRecord, type CompositionRecord } from './composition.js'

export async function validateC2PAComposition(
  asset: Uint8Array,
  manifest: Uint8Array | undefined,
  record: CompositionRecord,
  adapter: C2PAAdapter
): Promise<void> {
  validateCompositionRecord(record)
  if (manifest !== undefined) {
    lchAssert(
      toHex(await sha256(manifest)) === toHex(record.c2paManifestDigest),
      'ERR_LCH_PROVENANCE',
      'C2PA Manifest digest does not match the Composition Record'
    )
  }
  const bindings = await adapter.validate(asset, manifest)
  for (const ingredient of record.ingredients) {
    const binding = bindings.find(
      candidate =>
        toHex(candidate.sourceAssetId) === toHex(ingredient.sourceAssetId) &&
        candidate.hashedUri.url === ingredient.c2paIngredient.url &&
        candidate.hashedUri.alg === ingredient.c2paIngredient.alg &&
        toHex(candidate.hashedUri.hash) === toHex(ingredient.c2paIngredient.hash)
    )
    lchAssert(
      binding !== undefined,
      'ERR_LCH_PROVENANCE',
      'Composition ingredient is absent from C2PA'
    )
    lchAssert(
      binding.relationship === ingredient.relationship,
      'ERR_LCH_PROVENANCE',
      'C2PA relationship does not match composition'
    )
  }
}

export class StaticC2PAAdapter implements C2PAAdapter {
  constructor(private readonly bindings: C2PAIngredientBinding[]) {}

  async validate(): Promise<C2PAIngredientBinding[]> {
    return this.bindings
  }
}
