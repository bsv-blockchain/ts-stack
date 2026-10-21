import { CachedKeyDeriver, PrivateKey } from '@bsv/sdk'
import { jest } from '@jest/globals'
import { RabinPermissionModule } from '../index.js'
import { drivers } from '../scheduling.js'
import type { RabinPermissionModuleOptions } from '../types.js'
import { encryptArgs, execute, observe } from './helpers.js'

const BUSY = 'RABIN: key generation is busy'
const LIMITED = 'RABIN: key generation rate limit exceeded'
const UNLIMITED = {
  originatorGenerationBurst: 1000,
  globalGenerationBurst: 1000
} satisfies Partial<RabinPermissionModuleOptions>

const setup = (options: Partial<RabinPermissionModuleOptions> = {}, root = 61) => {
  const keyDeriver = new CachedKeyDeriver(new PrivateKey(root))
  const derivePrivateKey = jest.spyOn(keyDeriver, 'derivePrivateKey')
  const instance = new RabinPermissionModule({ keyDeriver, ...options })
  const derivedKeyIDs = () => derivePrivateKey.mock.calls.map(call => call[1])
  return { instance, derivePrivateKey, derivedKeyIDs }
}

const keyRequest = (keyID: string, bits = 2048) => encryptArgs('key', { keyID }, bits)

/** Lets queued microtasks and event-loop turns run without advancing fake timers. */
const settle = async (turns = 5) => {
  for (let i = 0; i < turns; i++) await new Promise<void>(resolve => setImmediate(resolve))
}

describe('key generation scheduling', () => {
  afterEach(() => {
    jest.useRealTimers()
    jest.restoreAllMocks()
  })

  it('runs one generation at a time, serves 8 distinct keys in order and refuses a 9th at once', async () => {
    const { instance, derivedKeyIDs } = setup(UNLIMITED)
    const driver = drivers.runCooperatively
    let active = 0
    let maxActive = 0
    const spy = jest.spyOn(drivers, 'runCooperatively').mockImplementation(async (...args) => {
      active++
      maxActive = Math.max(maxActive, active)
      try {
        return await driver(...args)
      } finally {
        active--
      }
    })
    const ids = Array.from({ length: 9 }, (_, i) => `key ${i}`)
    const outcomes = ids.map(keyID => observe(execute(instance, keyRequest(keyID))))
    const ninth = await outcomes[8]
    expect(ninth.ok).toBe(false)
    expect(String((ninth as { error: unknown }).error)).toContain(BUSY)
    expect(derivedKeyIDs()).not.toContain('key 8')

    const results = await Promise.all(outcomes.slice(0, 8))
    expect(results.every(outcome => outcome.ok)).toBe(true)
    // FIFO, one generation at a time.
    expect(derivedKeyIDs()).toEqual(ids.slice(0, 8))
    expect(spy).toHaveBeenCalledTimes(8)
    expect(maxActive).toBe(1)
  }, 60_000)

  it('joins a request for a key that is already being generated or queued', async () => {
    const { instance, derivePrivateKey } = setup(UNLIMITED)
    const results = await Promise.all([
      execute(instance, keyRequest('first')),
      execute(instance, keyRequest('second')),
      execute(instance, keyRequest('second')),
      execute(instance, encryptArgs('sign', { keyID: 'second' }))
    ])
    expect(results[1]).toEqual(results[2])
    expect(derivePrivateKey).toHaveBeenCalledTimes(2)
  }, 30_000)

  it('fails a request that waits in the queue longer than 60 s, without deriving it', async () => {
    jest.useFakeTimers({ doNotFake: ['performance', 'setImmediate', 'nextTick', 'queueMicrotask'] })
    const { instance, derivedKeyIDs } = setup(UNLIMITED)
    const running = observe(execute(instance, keyRequest('long', 4096)))
    await settle()
    const queued = observe(execute(instance, keyRequest('queued')))
    await settle()
    jest.advanceTimersByTime(60_001)
    const outcome = await queued
    expect(outcome.ok).toBe(false)
    expect(String((outcome as { error: unknown }).error)).toContain(BUSY)
    expect(derivedKeyIDs()).toEqual(['long'])
    instance.dispose()
    expect((await running).ok).toBe(false)
  }, 30_000)

  it('fails queued generations and stops signing when the module is disposed', async () => {
    const { instance, derivedKeyIDs } = setup(UNLIMITED)
    await execute(instance, keyRequest('signer', 4096))
    const running = observe(execute(instance, keyRequest('long', 4096)))
    await settle()
    const queued = observe(execute(instance, keyRequest('queued')))
    const signing = observe(execute(instance, encryptArgs('sign', { keyID: 'signer' }, 4096)))
    await settle(1)
    instance.dispose()
    const outcomes = await Promise.all([running, queued, signing])
    expect(outcomes.map(outcome => outcome.ok)).toEqual([false, false, false])
    expect(String((outcomes[1] as { error: unknown }).error)).toContain(
      'reset during key generation'
    )
    expect(String((outcomes[2] as { error: unknown }).error)).toContain('reset during signing')
    expect(derivedKeyIDs()).toEqual(['signer', 'long'])
  }, 60_000)

  it('rate-limits uncached generations per app and overall, refilling over time', async () => {
    // The buckets use the monotonic clock, so it is faked too.
    jest.useFakeTimers({ doNotFake: ['setImmediate', 'nextTick', 'queueMicrotask'] })
    jest.setSystemTime(1_000_000)
    const { instance, derivedKeyIDs } = setup()
    const generate = async (keyID: string, originator: string) =>
      await execute(instance, keyRequest(keyID), 'encrypt', originator)

    for (let i = 0; i < 4; i++) await generate(`a${i}`, 'a.example')
    await expect(generate('a4', 'a.example')).rejects.toThrow(LIMITED)
    expect(derivedKeyIDs()).not.toContain('a4')
    // Cache hits and other apps are not affected.
    await generate('a0', 'a.example')
    await generate('a0', 'b.example')
    await generate('b0', 'b.example')
    expect(derivedKeyIDs()).toHaveLength(5)

    jest.advanceTimersByTime(15_000)
    await generate('a4', 'a.example')

    // Global: burst 10, one more per 6 s. a0–a4 and b0 used 6, 15 s refilled 2.5: 6.5 remain.
    for (let i = 0; i < 6; i++) await generate(`c${i}`, `c${i}.example`)
    await expect(generate('c6', 'c6.example')).rejects.toThrow(LIMITED)
    expect(derivedKeyIDs()).not.toContain('c6')
  }, 60_000)

  it('authorizes before throttling and lets neither consume the other', async () => {
    jest.useFakeTimers({ doNotFake: ['setImmediate', 'nextTick', 'queueMicrotask'] })
    jest.setSystemTime(1_000_000)
    const authorize = jest.fn(async () => true)
    const { instance, derivedKeyIDs } = setup({ authorize, originatorGenerationBurst: 1 })
    const levelOne = (keyID: string) =>
      encryptArgs('key', { keyID, protocolID: [1, 'p rabin key 2048 example oracle'] })

    // A denied request consumes no generation token.
    authorize.mockResolvedValueOnce(false)
    await expect(execute(instance, levelOne('denied'))).rejects.toThrow('denied')
    await execute(instance, levelOne('first'))
    // The grant is cached, so the next request needs no prompt; it is throttled after that check.
    await expect(execute(instance, levelOne('second'))).rejects.toThrow(LIMITED)
    expect(derivedKeyIDs()).toEqual(['first'])

    // A fresh scope prompts first, then is throttled; the prompt is not skipped by the throttle.
    await expect(
      execute(instance, encryptArgs('key', { protocolID: [1, 'p rabin key 2048 other oracle'] }))
    ).rejects.toThrow(LIMITED)
    expect(authorize).toHaveBeenCalledTimes(3)
  }, 30_000)

  it('leaves no cache or queue entry after busy or failed requests', async () => {
    const failing = jest.fn(() => {
      throw new Error('deriver failed')
    })
    const failed = new RabinPermissionModule({
      keyDeriver: { derivePrivateKey: failing },
      ...UNLIMITED
    })
    for (let i = 0; i < 9; i++) {
      await expect(execute(failed, keyRequest('same'))).rejects.toThrow('deriver failed')
    }
    // Nine sequential failures neither filled the queue nor cached anything.
    expect(failing).toHaveBeenCalledTimes(9)

    const { instance, derivedKeyIDs } = setup({ ...UNLIMITED, maxPendingGenerations: 1 })
    const first = observe(execute(instance, keyRequest('one')))
    await expect(execute(instance, keyRequest('two'))).rejects.toThrow(BUSY)
    expect((await first).ok).toBe(true)
    // The busy request left nothing behind: it is admitted and generated now.
    await execute(instance, keyRequest('two'))
    expect(derivedKeyIDs()).toEqual(['one', 'two'])
  }, 30_000)

  it('signs one request at a time and refuses signatures beyond the queue at once', async () => {
    const { instance } = setup({ ...UNLIMITED, maxPendingSignatures: 2 })
    await execute(instance, keyRequest('signer'))
    const driver = drivers.runCooperatively
    let active = 0
    let maxActive = 0
    jest.spyOn(drivers, 'runCooperatively').mockImplementation(async (...args) => {
      active++
      maxActive = Math.max(maxActive, active)
      try {
        return await driver(...args)
      } finally {
        active--
      }
    })
    const sign = (i: number) =>
      observe(execute(instance, encryptArgs('sign', { keyID: 'signer', plaintext: [i] })))
    const outcomes = await Promise.all([sign(1), sign(2), sign(3)])
    expect(outcomes.map(outcome => outcome.ok)).toEqual([true, true, false])
    expect(String((outcomes[2] as { error: unknown }).error)).toContain('RABIN: signing is busy')
    expect(maxActive).toBe(1)
    // The queue drains: signing is not rate-limited, only bounded.
    expect((await sign(4)).ok).toBe(true)
  }, 30_000)

  it('asks the privileged key provider only after a generation is admitted', async () => {
    const keyDeriver = new CachedKeyDeriver(new PrivateKey(64))
    const provider = jest.fn(async () => new CachedKeyDeriver(new PrivateKey(65)))
    const instance = new RabinPermissionModule({
      keyDeriver,
      authorize: async () => true,
      privilegedKeyDeriver: provider,
      maxPendingGenerations: 1,
      originatorGenerationBurst: 1
    })
    const privileged = (originator: string) =>
      execute(
        instance,
        encryptArgs('key', { privileged: true, privilegedReason: 'Oracle signing' }),
        'encrypt',
        originator
      )
    const running = observe(execute(instance, keyRequest('ordinary'), 'encrypt', 'other.example'))
    await expect(privileged('p.example')).rejects.toThrow(BUSY)
    expect(provider).not.toHaveBeenCalled()
    expect((await running).ok).toBe(true)

    await privileged('p.example')
    expect(provider).toHaveBeenCalledTimes(1)
    await expect(privileged('p.example')).rejects.toThrow(LIMITED)
    expect(provider).toHaveBeenCalledTimes(1)
  }, 30_000)

  it('measures rate-limit refill on a monotonic clock, not the wall clock', async () => {
    const { instance, derivedKeyIDs } = setup({ originatorGenerationBurst: 1 })
    await execute(instance, keyRequest('first'))
    // The wall clock jumps an hour ahead (a clock change); no time has really passed.
    const wall = Date.now()
    jest.spyOn(Date, 'now').mockReturnValue(wall + 60 * 60 * 1000)
    await expect(execute(instance, keyRequest('second'))).rejects.toThrow(LIMITED)
    expect(derivedKeyIDs()).toEqual(['first'])
  }, 30_000)

  it('validates the scheduling options', () => {
    const keyDeriver = new CachedKeyDeriver(new PrivateKey(62))
    for (const options of [
      { maxPendingGenerations: 0 },
      { generationQueueTimeout: 0 },
      { originatorGenerationBurst: 0 },
      { originatorGenerationInterval: 0 },
      { globalGenerationBurst: 0 },
      { globalGenerationInterval: 0 },
      { maxCachedKeysPerOriginator: 0 },
      { maxCachedKeys: 4, maxCachedKeysPerOriginator: 8 },
      { maxPendingSignatures: 0 }
    ]) {
      expect(() => new RabinPermissionModule({ keyDeriver, ...options })).toThrow(/^RABIN: /)
    }
  })
})
