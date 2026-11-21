'use strict'
const { runNativeBrowserDriver, nativeBrowserTestTimeout } = require('../../client/test/native-browser-driver.cjs')

// No mock Worker brand or simulated positive backend. The browser/controller
// is a fresh real owner. Qualification needs CHROME_BIN and a separately agreed
// browser/esbuild/KDF process budget; coverage is not a process-tree receipt.
test(
  'actual dedicated workers preserve original KDF/cancellation and per-test coverage',
  async () => {
    const namespace = globalThis.__stryker__
    const context = {
      currentTestId: namespace?.currentTestId,
      activeMutant: namespace?.activeMutant ?? process.env.__STRYKER_ACTIVE_MUTANT__,
      hitLimit: namespace?.hitLimit
    }
    const result = await runNativeBrowserDriver('argon2id-coverage', context)
    expect(result.nativeWorkerCount).toBe(2)
    expect(result.browserChildClose).toEqual({ code: 0, signal: null })
    expect(result.processTreeQualified).toBe(false)
    for (const receipts of result.workers) {
      expect(receipts.length).toBeGreaterThan(0)
      for (const receipt of receipts) {
        expect(receipt.channel).toEqual({ origin: '', sourceIsNull: true, isTrusted: true })
      }
    }
    if (namespace === undefined) return
    const cumulative = { static: {}, perTest: {} }
    const merge = (into, from, maximum) => {
      for (const [id, count] of Object.entries(from ?? {})) {
        expect(id).toMatch(/^\d+$/)
        expect(Number.isSafeInteger(count) && count >= 0).toBe(true)
        into[id] = maximum ? Math.max(into[id] ?? 0, count) : (into[id] ?? 0) + count
        expect(Number.isSafeInteger(into[id])).toBe(true)
      }
    }
    const accept = (into, from, maximum) => {
      if (from === undefined) return
      merge(into.static, from.static, maximum)
      for (const [testId, counters] of Object.entries(from.perTest ?? {})) {
        expect(testId).toBe(context.currentTestId)
        into.perTest[testId] ??= {}
        merge(into.perTest[testId], counters, maximum)
      }
    }
    accept(cumulative, result.main, false)
    for (const receipts of result.workers) {
      const worker = { static: {}, perTest: {} }
      let sequence = 0
      expect(receipts.length).toBeGreaterThan(0)
      expect(receipts.length).toBeLessThanOrEqual(32)
      for (const receipt of receipts) {
        expect(receipt.sequence).toBe(++sequence)
        expect(['ready', 'key', 'failed', 'close']).toContain(receipt.phase)
        // Each received worker snapshot is cumulative: max inside one actual
        // worker, sum across independent real workers. Never fabricate counters.
        accept(worker, receipt.coverage, true)
      }
      accept(cumulative, worker, false)
    }
    namespace.mutantCoverage ??= { static: {}, perTest: {} }
    accept(namespace.mutantCoverage, cumulative, false)
  },
  nativeBrowserTestTimeout()
)
