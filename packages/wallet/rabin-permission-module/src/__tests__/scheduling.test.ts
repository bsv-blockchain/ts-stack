import { jest } from '@jest/globals'
import { generateKey, generateKeySteps, assembleKey, sign, signSteps } from '../rabin.js'
import { runCooperatively, yieldToEventLoop } from '../scheduling.js'
import { beHex, fromHex, keyVector, vectors } from './helpers.js'

describe('cooperative key generation', () => {
  it('produces byte-identical keys and signatures with the synchronous and cooperative drivers', async () => {
    for (const vector of vectors.keys) {
      const seed = fromHex(vector.derivation.seed)
      const synchronous = generateKey(seed, vector.key.bits)
      const cooperative = await runCooperatively(generateKeySteps(seed, vector.key.bits))
      expect(cooperative).toEqual(synchronous)
      expect(cooperative.n).toBe(beHex(vector.key.n))
    }
    for (const vector of vectors.signatures) {
      const kv = keyVector(vector.keyVector)
      const key = assembleKey(beHex(kv.key.p), beHex(kv.key.q), kv.key.bits)
      const message = fromHex(vector.message.hex)
      const cooperative = await runCooperatively(signSteps(message, key))
      expect(cooperative).toEqual(sign(message, key))
      expect(cooperative.sig).toBe(beHex(vector.signature.sig))
    }
  }, 60_000)

  it('stops a cancelled generation at the next slice boundary', async () => {
    let cancelled = false
    const run = runCooperatively(
      generateKeySteps(
        Array.from({ length: 32 }, () => 7),
        4096
      ),
      {
        budgetMs: 0,
        isCancelled: () => cancelled,
        cancelledError: () => new Error('RABIN: the module was reset during key generation')
      }
    )
    cancelled = true
    await expect(run).rejects.toThrow('reset during key generation')
  })
})

describe('yieldToEventLoop', () => {
  const globals = globalThis as unknown as Record<string, unknown>

  afterEach(() => {
    jest.restoreAllMocks()
  })

  it('prefers scheduler.yield when the host provides it', async () => {
    const previous = globals.scheduler
    const yieldFn = jest.fn(async () => undefined)
    globals.scheduler = { yield: yieldFn }
    try {
      await yieldToEventLoop()
      expect(yieldFn).toHaveBeenCalledTimes(1)
    } finally {
      globals.scheduler = previous
    }
  })

  it('uses setImmediate in Node, a MessageChannel elsewhere, and never setTimeout', async () => {
    const setTimeoutSpy = jest.spyOn(globalThis, 'setTimeout')
    const setImmediateSpy = jest.spyOn(globalThis, 'setImmediate')
    await yieldToEventLoop()
    expect(setImmediateSpy).toHaveBeenCalledTimes(1)

    // Outside Node (no process.versions.node) a MessageChannel message is used.
    const processDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'process')!
    Object.defineProperty(globalThis, 'process', { ...processDescriptor, value: { versions: {} } })
    try {
      await yieldToEventLoop()
      await yieldToEventLoop()
      expect(setImmediateSpy).toHaveBeenCalledTimes(1)
      const channel = globals.MessageChannel
      globals.MessageChannel = undefined
      try {
        await yieldToEventLoop()
        expect(setImmediateSpy).toHaveBeenCalledTimes(2)
        // A host with none of these still continues, after a microtask.
        const immediate = globals.setImmediate
        globals.setImmediate = undefined
        try {
          await expect(yieldToEventLoop()).resolves.toBeUndefined()
        } finally {
          globals.setImmediate = immediate
        }
      } finally {
        globals.MessageChannel = channel
      }
    } finally {
      Object.defineProperty(globalThis, 'process', processDescriptor)
    }
    expect(setTimeoutSpy).not.toHaveBeenCalled()
  })
})
