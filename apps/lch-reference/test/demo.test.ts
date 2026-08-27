import { describe, expect, it } from 'vitest'
import {
  EDITORIAL_CASES,
  buildEditorialComposition,
  createToneWav,
  runCoreProfileChecks,
  transformToneWav,
  type EditorialPlacement
} from '../src/demo.js'

describe('reference media fixture', () => {
  it('creates a valid PCM WAV envelope', () => {
    const bytes = createToneWav(1)
    expect(new TextDecoder().decode(bytes.slice(0, 4))).toBe('RIFF')
    expect(new TextDecoder().decode(bytes.slice(8, 12))).toBe('WAVE')
    expect(bytes.length).toBeGreaterThan(44)
  })

  it.each([
    { id: 1, label: 'half speed', kind: 'time-warp', rateNumerator: 1, rateDenominator: 2 },
    { id: 2, label: 'double speed', kind: 'time-warp', rateNumerator: 2, rateDenominator: 1 },
    { id: 3, label: 'reverse', kind: 'reverse' },
    { id: 4, label: 'distorted', kind: 'distortion', distortionAmount: 4 }
  ] as EditorialPlacement[])('renders the $label editorial edge case', placement => {
    const source = createToneWav(1)
    const transformed = transformToneWav(source, placement)
    expect(new TextDecoder().decode(transformed.slice(0, 4))).toBe('RIFF')
    if (placement.rateNumerator === 1) expect(transformed.length).toBeGreaterThan(source.length)
    if (placement.rateNumerator === 2) expect(transformed.length).toBeLessThan(source.length)
    if (placement.kind === 'reverse' || placement.kind === 'distortion') {
      expect(transformed).not.toEqual(source)
    }
  })

  it('rejects non-positive or non-integer playback-rate ratios', () => {
    const source = createToneWav(1)
    expect(() =>
      transformToneWav(source, {
        id: 1,
        label: 'zero denominator',
        kind: 'time-warp',
        rateNumerator: 1,
        rateDenominator: 0
      })
    ).toThrow(/positive safe integers/u)
    expect(() =>
      transformToneWav(source, {
        id: 2,
        label: 'fractional numerator',
        kind: 'time-warp',
        rateNumerator: 0.5,
        rateDenominator: 1
      })
    ).toThrow(/positive safe integers/u)
  })

  it('records repeats and transformed edits as distinct whole placements', async () => {
    const placements: EditorialPlacement[] = [
      { id: 1, label: 'repeat a', kind: 'identity' },
      { id: 2, label: 'repeat b', kind: 'identity' },
      ...EDITORIAL_CASES.slice(1).map((item, index) => ({ id: index + 3, ...item }))
    ]
    const record = await buildEditorialComposition(
      new Uint8Array(32).fill(1),
      new Uint8Array(32).fill(2),
      placements
    )
    expect(record.ingredients).toHaveLength(placements.length)
    expect(new Set(record.ingredients.map(item => item.c2paIngredient.url)).size).toBe(
      placements.length
    )
    expect(record.ingredients.every(item => item.derivedSelection.type === 'all')).toBe(true)
  })

  it('exercises every initial profile and its reference boundary cases', async () => {
    const result = await runCoreProfileChecks(
      new Uint8Array(32).fill(3),
      new Uint8Array(32).fill(4)
    )
    expect(result).toHaveLength(6)
    expect(result.every(item => item.status === 'pass')).toBe(true)
  })
})
