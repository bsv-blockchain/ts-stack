import { generateKeySteps } from '../rabin.js'
import { runCooperatively } from '../scheduling.js'

// Real-clock measurements. Kept apart from the other tests so mutation testing, whose
// instrumentation distorts timing, can skip them.
describe('cooperative key generation responsiveness', () => {
  // Real clock, slow: a 4096-bit generation must leave the event loop responsive throughout.
  it('[slow] keeps every slice under 10 ms and the event loop ticking during a 4096-bit generation', async () => {
    const slices: number[] = []
    let last = performance.now()
    let maxGap = 0
    const ticker = setInterval(() => {
      const now = performance.now()
      maxGap = Math.max(maxGap, now - last)
      last = now
    }, 1)
    try {
      const key = await runCooperatively(
        generateKeySteps(
          Array.from({ length: 32 }, (_, i) => i + 1),
          4096
        ),
        {
          onSlice: ms => slices.push(ms)
        }
      )
      expect(key.n.toString(2)).toHaveLength(4096)
    } finally {
      clearInterval(ticker)
    }
    expect(slices.length).toBeGreaterThan(10)
    expect(Math.max(...slices)).toBeLessThan(10)
    expect(maxGap).toBeLessThanOrEqual(50)
  }, 180_000)

  it('lets setImmediate callbacks and I/O run between slices in Node', async () => {
    let finished = false
    const generation = runCooperatively(
      generateKeySteps(
        Array.from({ length: 32 }, (_, i) => 255 - i),
        4096
      )
    ).then(() => {
      finished = true
    })
    const started = performance.now()
    for (let i = 0; i < 5; i++) await new Promise<void>(resolve => setImmediate(resolve))
    expect(performance.now() - started).toBeLessThan(100)
    expect(finished).toBe(false)
    await generation
  }, 180_000)
})
