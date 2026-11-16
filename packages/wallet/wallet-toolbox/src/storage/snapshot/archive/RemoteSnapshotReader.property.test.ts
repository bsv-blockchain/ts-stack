import fc from 'fast-check'
import { openRemoteSnapshot } from './openRemoteSnapshot'
import { label, remoteReaderFixture } from '../../../../test/utils/remoteSnapshotReaderFixtures'
import type { WalletSnapshotCursor } from '../WalletReadSnapshot'
import { drainSnapshotArchiveRequest, SnapshotArchiveCleanupPendingError } from './SnapshotArchiveCleanup'
import { SnapshotArchiveTransportFailure } from './SnapshotArchiveTransportFailure'
import { getEventListeners } from 'node:events'

const MIN_PROPERTY_RUNS = 300
const requestedRuns = Number.parseInt(process.env.FAST_CHECK_NUM_RUNS ?? '', 10)
const requestedSeed = Number.parseInt(process.env.FAST_CHECK_SEED ?? '', 10)
const replayPath = process.env.FAST_CHECK_PATH
fc.configureGlobal({
  numRuns: Number.isSafeInteger(requestedRuns) ? Math.max(MIN_PROPERTY_RUNS, requestedRuns) : MIN_PROPERTY_RUNS,
  ...(Number.isSafeInteger(requestedSeed) ? { seed: requestedSeed } : {}),
  ...(replayPath !== undefined && replayPath !== '' ? { path: replayPath } : {})
})

test('generated pending-cleanup and lost-ack schedules preserve one signal, failure identity and bounded polling', async () => {
  jest.useFakeTimers()
  try {
    await fc.assert(
      fc.asyncProperty(fc.array(fc.boolean(), { maxLength: 8 }), fc.boolean(), async (lost, fails) => {
        let position = 0
        let retry = false
        let calls = 0
        const signals = new Set<AbortSignal>()
        const failure = new Error('synthetic independent cleanup failure')
        const closing = drainSnapshotArchiveRequest(async signal => {
          calls++
          signals.add(signal)
          expect(signal.aborted).toBe(false)
          expect(getEventListeners(signal, 'abort')).toHaveLength(0)
          if (position < lost.length) {
            if (lost[position] && !retry) {
              retry = true
              throw new SnapshotArchiveTransportFailure('synthetic lost acknowledgement')
            }
            position++
            retry = false
            throw new SnapshotArchiveCleanupPendingError()
          }
          if (fails) throw failure
        })
        const outcome = closing.then(
          () => undefined,
          error => error
        )
        await jest.advanceTimersByTimeAsync(10000)
        if (fails) expect(await outcome).toBe(failure)
        else expect(await outcome).toBeUndefined()
        expect(calls).toBe(1 + lost.length + lost.filter(Boolean).length)
        expect(position).toBe(lost.length)
        expect(signals.size).toBe(1)
        expect(jest.getTimerCount()).toBe(0)
        for (const signal of signals) expect(getEventListeners(signal, 'abort')).toHaveLength(0)
      })
    )
  } finally {
    jest.useRealTimers()
  }
})

test('generated frame/page boundaries preserve exact rows, final keys, allocation charges and immutable retries', async () => {
  await fc.assert(
    fc.asyncProperty(
      fc.array(fc.string({ maxLength: 40 }), { minLength: 1, maxLength: 64 }),
      fc.integer({ min: 1, max: 17 }),
      fc.integer({ min: 1, max: 13 }),
      async (names, frameRows, maxRows) => {
        const expected = names.map((name, index) => label(index + 1, name))
        const fixture = remoteReaderFixture(expected, 'txLabels', frameRows)
        const view = (await openRemoteSnapshot(fixture.transport))!
        try {
          let cursor: WalletSnapshotCursor | undefined
          let consumed = 0
          let done = false
          while (!done) {
            const page = await view.readPage('txLabels', cursor, { maxRows, maxBytes: 65536 })
            expect(page.rows).toEqual(expected.slice(consumed, consumed + maxRows))
            expect(page.payloadBytes).toBe(page.rows.reduce((sum, row) => sum + 384 + row.label.length * 2, 0))
            expect(await view.readPage('txLabels', cursor, { maxRows, maxBytes: 65536 })).toEqual(page)
            consumed += page.rows.length
            expect(page.cursor!.after).toEqual([consumed])
            expect(page.cursor!.archivePosition).toEqual({
              version: 1,
              archiveId: fixture.directory.archiveId,
              sequence: 8 + Math.floor((consumed - 1) / frameRows),
              rowOffset: ((consumed - 1) % frameRows) + 1
            })
            cursor = page.cursor
            done = page.done
            expect(done).toBe(consumed === expected.length)
          }
          expect(consumed).toBe(expected.length)
          expect((await view.readPage('txLabels', cursor)).rows).toEqual([])
          const sequenceRequests = fixture.rpc.mock.calls
            .filter(([method]) => method === 'readSnapshotArchivePage')
            .map(([, params]) => (params[0] as { sequence: number }).sequence)
          expect(
            sequenceRequests.every(sequence => sequence >= 8 && sequence < 8 + Math.ceil(expected.length / frameRows))
          ).toBe(true)
          await expect(
            view.readPage('txLabels', {
              ...cursor!,
              archivePosition: { ...cursor!.archivePosition!, archiveId: 'c'.repeat(64) }
            })
          ).rejects.toThrow()
        } finally {
          await view.close()
        }
        expect(fixture.rpc.mock.calls.filter(([method]) => method === 'cancelSnapshotArchiveRequest')).toHaveLength(1)
      }
    )
  )
})
