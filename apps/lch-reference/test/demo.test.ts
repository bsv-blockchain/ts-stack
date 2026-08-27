import { describe, expect, it } from 'vitest'
import { createToneWav } from '../src/demo.js'

describe('reference media fixture', () => {
  it('creates a valid PCM WAV envelope', () => {
    const bytes = createToneWav(1)
    expect(new TextDecoder().decode(bytes.slice(0, 4))).toBe('RIFF')
    expect(new TextDecoder().decode(bytes.slice(8, 12))).toBe('WAVE')
    expect(bytes.length).toBeGreaterThan(44)
  })
})
