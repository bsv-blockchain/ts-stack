import { describe, expect, it } from '@jest/globals'
import {
  LCHComposer,
  LCH_MECHANISMS,
  StaticC2PAAdapter,
  matchFinalizedOutputs,
  recoveryUntil,
  sha256,
  validateC2PAComposition,
  validateIngredient,
  walkComposition
} from '../src/index.js'

const id = (value: number): Uint8Array => new Uint8Array(32).fill(value)

describe('composition and payment invariants', () => {
  it('builds only the pinned whole-placement mapping', () => {
    const record = new LCHComposer(id(9))
      .addWholePlacement({
        sourceAssetId: id(1),
        sourceLicenseId: id(2),
        c2paIngredient: {
          url: 'self#jumbf=/c2pa/source/c2pa.assertions/c2pa.ingredient.v3',
          alg: 'sha256',
          hash: id(3)
        },
        relationship: 'componentOf',
        sourceSelection: { type: 'segments', ranges: [[2, 4]] }
      })
      .build()
    expect(record.ingredients[0].mappingProfile).toBe(LCH_MECHANISMS.wholePlacement)
    expect(() =>
      validateIngredient({
        ...record.ingredients[0],
        mappingProfile: 'https://app.example/trim-v1'
      })
    ).toThrow()
  })

  it('matches demand outputs after wallet reordering', () => {
    const scriptA = Uint8Array.of(1)
    const scriptB = Uint8Array.of(2)
    const result = matchFinalizedOutputs(
      [
        { demandId: id(1), satoshis: 7n, lockingScript: scriptA },
        { demandId: id(2), satoshis: 5n, lockingScript: scriptB }
      ],
      [
        { satoshis: 100n, lockingScript: Uint8Array.of(3) },
        { satoshis: 5n, lockingScript: scriptB },
        { satoshis: 7n, lockingScript: scriptA }
      ]
    )
    expect([...result.values()]).toEqual([2, 1])
  })

  it('rejects ambiguous matches and computes recovery deadlines', () => {
    expect(() =>
      matchFinalizedOutputs([{ demandId: id(1), satoshis: 1n, lockingScript: id(2) }], [])
    ).toThrow()
    expect(recoveryUntil(1_000n, 86_400n)).toBe(87_400n)
  })

  it('rejects composition cycles even when the repeated Asset uses another selection', async () => {
    const ingredient = (sourceAssetId: Uint8Array, value: number) => ({
      sourceAssetId,
      sourceLicenseId: id(value),
      c2paIngredient: {
        url: `self#jumbf=/c2pa/${value}`,
        alg: 'sha256',
        hash: id(value + 1)
      },
      relationship: 'componentOf' as const,
      sourceSelection: { type: 'segments' as const, ranges: [[value, value + 1]] },
      derivedSelection: { type: 'all' as const },
      mappingProfile: LCH_MECHANISMS.wholePlacement
    })
    const assetA = id(10)
    const assetB = id(11)
    const recordA = {
      version: 1 as const,
      c2paManifestDigest: id(12),
      ingredients: [ingredient(assetB, 1)]
    }
    const recordB = {
      version: 1 as const,
      c2paManifestDigest: id(13),
      ingredients: [ingredient(assetA, 2)]
    }
    await expect(
      walkComposition(
        { assetId: assetA, selection: { type: 'all' }, record: recordA },
        async sourceAssetId => ({
          assetId: sourceAssetId,
          selection: { type: 'all' },
          record: sourceAssetId[0] === assetA[0] ? recordA : recordB
        })
      )
    ).rejects.toMatchObject({ code: 'ERR_LCH_CYCLE' })
  })

  it('binds the exact C2PA hashed URI and manifest digest', async () => {
    const manifest = new TextEncoder().encode('detached c2pa manifest')
    const hashedUri = {
      url: 'self#jumbf=/c2pa/source/c2pa.assertions/c2pa.ingredient.v3',
      alg: 'sha256',
      hash: id(21)
    }
    const record = new LCHComposer(await sha256(manifest))
      .addWholePlacement({
        sourceAssetId: id(20),
        sourceLicenseId: id(22),
        c2paIngredient: hashedUri,
        relationship: 'componentOf',
        sourceSelection: { type: 'all' }
      })
      .build()
    const adapter = new StaticC2PAAdapter([
      { sourceAssetId: id(20), relationship: 'componentOf', hashedUri }
    ])
    await expect(
      validateC2PAComposition(id(23), manifest, record, adapter)
    ).resolves.toBeUndefined()
    await expect(
      validateC2PAComposition(id(23), new Uint8Array(manifest.length), record, adapter)
    ).rejects.toMatchObject({ code: 'ERR_LCH_PROVENANCE' })
  })
})
