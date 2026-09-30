import fc from 'fast-check'
import { runInSeries } from '../../utility/runInSeries'
import { retainReadSnapshot } from './RetainedReadSnapshot'

const MIN_PROPERTY_RUNS = 300
const requestedRuns = Number.parseInt(process.env.FAST_CHECK_NUM_RUNS ?? '', 10)
const requestedSeed = Number.parseInt(process.env.FAST_CHECK_SEED ?? '', 10)
const replayPath = process.env.FAST_CHECK_PATH
fc.configureGlobal({
  numRuns: Number.isSafeInteger(requestedRuns) ? Math.max(MIN_PROPERTY_RUNS, requestedRuns) : MIN_PROPERTY_RUNS,
  ...(Number.isSafeInteger(requestedSeed) ? { seed: requestedSeed } : {}),
  ...(replayPath !== undefined && replayPath !== '' ? { path: replayPath } : {})
})

function gate() {
  let resolve!: () => void
  const promise = new Promise<void>(yes => {
    resolve = yes
  })
  return { promise, resolve }
}

type Outcome = { ok: true; value: number } | { ok: false; error: unknown }
interface PendingRead {
  value: number
  release: () => void
  outcome: Promise<Outcome>
  settled: () => boolean
}

const operations = fc.array(fc.constantFrom('read', 'settle', 'close', 'cancel', 'advance'), {
  minLength: 1,
  maxLength: 40
})

afterEach(() => {
  jest.useRealTimers()
})

test('random schedules preserve single-read admission, late-result rejection and physical cleanup ownership', async () => {
  jest.useFakeTimers()
  await fc.assert(
    fc.asyncProperty(operations, fc.integer({ min: 1, max: 1000 }), async (steps, lifetimeMs) => {
      const controller = new AbortController()
      const cleanup = gate()
      const token = { synthetic: true }
      let physicalReads = 0
      let enteredReads = 0
      let leftCallback = false
      let released = false
      let closed = false
      let pending: PendingRead | undefined
      let expectedReads = 0
      let alive = true
      let elapsed = 0
      const lifetime = retainReadSnapshot(
        async read => {
          try {
            await read(token)
          } finally {
            leftCallback = true
            await cleanup.promise
            released = true
          }
        },
        async received => {
          expect(received).toBe(token)
        },
        { signal: controller.signal, lifetimeMs }
      )
      void lifetime.closed.catch(() => undefined)
      const view = await lifetime.opened.catch(async error => {
        cleanup.resolve()
        await lifetime.closed.catch(() => undefined)
        throw error
      })
      void view.closed.then(
        () => {
          closed = true
        },
        () => undefined
      )

      const finishRead = async (): Promise<void> => {
        if (pending === undefined) return
        const active = pending
        active.release()
        const outcome = await active.outcome
        if (alive) expect(outcome).toEqual({ ok: true, value: active.value })
        else expect(outcome).toEqual({ ok: false, error: expect.any(Error) })
        pending = undefined
        expect(physicalReads).toBe(0)
      }
      try {
        // Each generated operation awaits the previous operation's observations;
        // the database read itself remains independently held until `settle`.
        await runInSeries(steps, async step => {
          if (step === 'read') {
            if (!alive || pending !== undefined) {
              const extra = jest.fn(async () => 1)
              await expect(view.read(extra)).rejects.toBeInstanceOf(Error)
              expect(extra).not.toHaveBeenCalled()
            } else {
              const held = gate()
              const value = ++expectedReads
              let settled = false
              const outcome: Promise<Outcome> = view
                .read(async received => {
                  expect(received).toBe(token)
                  physicalReads++
                  enteredReads++
                  expect(physicalReads).toBe(1)
                  await held.promise
                  physicalReads--
                  return value
                })
                .then(
                  result => {
                    settled = true
                    return { ok: true, value: result }
                  },
                  error => {
                    settled = true
                    return { ok: false, error }
                  }
                )
              pending = { value, release: held.resolve, outcome, settled: () => settled }
            }
          } else if (step === 'settle') {
            await finishRead()
          } else if (step === 'advance') {
            elapsed += 250
            if (elapsed >= lifetimeMs) alive = false
            jest.advanceTimersByTime(250)
          } else {
            alive = false
            if (step === 'cancel') controller.abort()
            else void view.close().catch(() => undefined)
          }
          // Observe both read continuation and provider callback handoffs.
          await Promise.resolve()
          await Promise.resolve()
          expect(view.isOpen).toBe(alive)
          expect(enteredReads).toBe(expectedReads)
          expect(released).toBe(false)
          expect(closed).toBe(false)
          if (pending !== undefined) {
            expect(pending.settled()).toBe(false)
            expect(physicalReads).toBe(1)
            expect(leftCallback).toBe(false)
          }
        })
        await finishRead()
      } finally {
        const closing = view.close()
        pending?.release()
        await pending?.outcome
        cleanup.resolve()
        await closing
      }
      expect(physicalReads).toBe(0)
      expect(released).toBe(true)
      expect(closed).toBe(true)
      expect(view.isOpen).toBe(false)
      expect(jest.getTimerCount()).toBe(0)
    })
  )
})
