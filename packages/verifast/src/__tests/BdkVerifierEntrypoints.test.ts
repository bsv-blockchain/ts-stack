import NodeBdkVerifier from '../BdkVerifier.js'
import BrowserBdkVerifier from '../BdkVerifier.browser.js'
import type { BdkVerificationResult, BdkWasmModule } from '../BdkVerifierTypes.js'
import { jest } from '@jest/globals'

class MockVector {
  push_back(_value: number): void {}
  delete(): void {}
}

function module(): BdkWasmModule {
  return {
    VectorUInt8: MockVector,
    VectorInt32: MockVector,
    VectorUInt32: MockVector,
    VerifyScript: (): BdkVerificationResult => ({ domain: 0, code: 0 })
  }
}

describe('published verifier entrypoints', () => {
  it.each([
    ['node', NodeBdkVerifier],
    ['browser', BrowserBdkVerifier]
  ] as const)(
    'supports an injected WASM factory through the %s entrypoint',
    async (_name, Verifier) => {
      const factory = jest.fn(async () => module())
      const verifier = new Verifier(factory, { registerAsDefault: false })

      await verifier.preload()

      expect(factory).toHaveBeenCalledTimes(1)
      expect(verifier.isReady()).toBe(true)
      verifier.dispose()
    }
  )

  it.each([
    ['node', NodeBdkVerifier],
    ['browser', BrowserBdkVerifier]
  ] as const)('validates worker counts through the %s entrypoint', (_name, Verifier) => {
    expect(
      () =>
        new Verifier({
          batchWorkers: 0,
          registerAsDefault: false
        })
    ).toThrow('batchWorkers must be a safe integer from 1 to 16')
    expect(
      () =>
        new Verifier({
          batchWorkers: 17,
          registerAsDefault: false
        })
    ).toThrow('batchWorkers must be a safe integer from 1 to 16')
  })

  it('can disable Node worker fan-out explicitly', () => {
    const verifier = new NodeBdkVerifier({
      batchWorkers: 1,
      registerAsDefault: false
    })
    expect(verifier.isReady()).toBe(false)
    verifier.dispose()
  })

  it('falls back to the main thread when browser workers are unavailable', () => {
    const originalWorker = globalThis.Worker
    Object.defineProperty(globalThis, 'Worker', {
      configurable: true,
      value: undefined
    })
    try {
      const verifier = new BrowserBdkVerifier({
        batchWorkers: 2,
        registerAsDefault: false
      })
      expect(verifier.isReady()).toBe(false)
      verifier.dispose()
    } finally {
      Object.defineProperty(globalThis, 'Worker', {
        configurable: true,
        value: originalWorker
      })
    }
  })
})
