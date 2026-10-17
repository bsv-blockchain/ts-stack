import {
  runSnapshotJournalReconciliation,
  type SnapshotJournalReconciliationDestination
} from './runSnapshotJournalReconciliation'
import type { SnapshotJournalDestinationCheckpoint } from './SnapshotJournalDestinationWindow'
import type { SnapshotJournalProgress } from './SnapshotJournalProgress'
import { SnapshotCancelledError } from '../SnapshotCancelledError'

function gate() {
  let resolve!: () => void
  const promise = new Promise<void>(yes => {
    resolve = yes
  })
  return { promise, resolve }
}
function fixture() {
  let checkpoint: SnapshotJournalDestinationCheckpoint = {
    version: 1,
    sessionId: '11'.repeat(32),
    binding: '22'.repeat(32),
    sequence: 0,
    phase: 'intake',
    streamIndex: 0,
    tableIndex: 0,
    promotionSequence: 0
  }
  let progress: SnapshotJournalProgress = { commits: 0, pages: 0, examined: 0, payloadBytes: 0, inserts: 0, updates: 0 }
  const close = jest.fn(async () => undefined)
  const source = { close, closed: Promise.resolve() }
  const advance = (phase: SnapshotJournalDestinationCheckpoint['phase']) => {
    checkpoint = { ...checkpoint, phase, sequence: checkpoint.sequence + 1 }
    progress = {
      ...progress,
      commits: progress.commits + 1,
      pages: progress.pages + 1,
      examined: progress.examined + 3,
      payloadBytes: progress.payloadBytes + 123
    }
  }
  const status = jest.fn(async () => ({ checkpoint: { ...checkpoint }, progress: { ...progress } }))
  const intake = jest.fn(async () => {
    advance('promoting')
  })
  const promote = jest.fn(async () => {
    advance('acknowledged')
  })
  const destination: SnapshotJournalReconciliationDestination = { status, intake, promote }
  return { source, destination, close, status, intake, promote, advance }
}

test('yields actual durable counters, owns observer copies and closes before completion', async () => {
  const f = fixture()
  const iterator = runSnapshotJournalReconciliation(f.source, async () => f.destination, {
    onProgress(value) {
      value.progress.pages = 999
      value.checkpoint.sequence = 999
    }
  })
  expect((await iterator.next()).value).toMatchObject({ state: 'committed', progress: { pages: 1 } })
  expect(f.close).not.toHaveBeenCalled()
  expect((await iterator.next()).value).toMatchObject({ state: 'committed', progress: { pages: 2 } })
  expect((await iterator.next()).value).toMatchObject({ state: 'complete', progress: { commits: 2 } })
  expect(f.close).toHaveBeenCalledTimes(1)
  expect((await iterator.next()).done).toBe(true)
})

test('a lost committed reply resumes the actual checkpoint without replaying intake', async () => {
  const f = fixture()
  f.intake.mockImplementationOnce(async () => {
    f.advance('promoting')
    throw new Error('lost ordinary reply')
  })
  const values = []
  for await (const value of runSnapshotJournalReconciliation(f.source, async () => f.destination)) values.push(value)
  expect(values.map(value => value.state)).toEqual(['committed', 'committed', 'complete'])
  expect(f.intake).toHaveBeenCalledTimes(1)
  expect(f.promote).toHaveBeenCalledTimes(1)
  expect(values[0].checkpoint.phase).toBe('promoting')
})

test('an unchanged durable checkpoint cannot turn an operation failure into success', async () => {
  const f = fixture()
  f.intake.mockRejectedValueOnce(new Error('ordinary uncommitted failure'))
  const iterator = runSnapshotJournalReconciliation(f.source, async () => f.destination)
  await expect(iterator.next()).rejects.toThrow('ordinary uncommitted failure')
  expect(f.promote).not.toHaveBeenCalled()
  expect(f.close).toHaveBeenCalledTimes(1)
})

test('cancel after commit reports the recovered ACK, and stopped waits for physical closure', async () => {
  const f = fixture(),
    controller = new AbortController(),
    entered = gate(),
    drained = gate()
  f.source.closed = drained.promise
  f.close.mockImplementation(async () => {
    entered.resolve()
    await drained.promise
  })
  f.intake.mockImplementationOnce(async () => {
    f.advance('promoting')
    controller.abort()
    throw new Error('cancelled ordinary reply')
  })
  const iterator = runSnapshotJournalReconciliation(f.source, async () => f.destination, { signal: controller.signal })
  expect((await iterator.next()).value).toMatchObject({ state: 'cancelRequested', progress: { pages: 1 } })
  let stopped = false
  const stopping = iterator.next().then(value => {
    stopped = true
    return value
  })
  await entered.promise
  expect(stopped).toBe(false)
  drained.resolve()
  expect((await stopping).value).toMatchObject({ state: 'stopped', progress: { pages: 1 } })
  expect(f.promote).not.toHaveBeenCalled()
  await iterator.next()
  expect(f.close).toHaveBeenCalledTimes(1)
})

test('consumer abandonment closes the retained source without promoting another page', async () => {
  const f = fixture()
  const iterator = runSnapshotJournalReconciliation(f.source, async () => f.destination)
  const first = await iterator.next()
  expect(first.done).toBe(false)
  await iterator.return(first.value)
  expect(f.close).toHaveBeenCalledTimes(1)
  expect(f.promote).not.toHaveBeenCalled()
})

test('destination admission failure still drains the owned source', async () => {
  const f = fixture()
  const iterator = runSnapshotJournalReconciliation(f.source, async () => {
    throw new Error('ordinary admission refusal')
  })
  await expect(iterator.next()).rejects.toThrow('ordinary admission refusal')
  expect(f.close).toHaveBeenCalledTimes(1)
})

test('expected logical cancellation still waits for the physical closed acknowledgement', async () => {
  const f = fixture(),
    controller = new AbortController(),
    entered = gate(),
    drained = gate()
  const cancellation = new SnapshotCancelledError('Source capture cancelled')
  controller.abort(cancellation)
  f.close.mockImplementation(async () => {
    entered.resolve()
    throw cancellation
  })
  f.source.closed = drained.promise.then(() => {
    throw cancellation
  })
  // Attach a handler before the rejected lifetime is observed by the iterator.
  void f.source.closed.catch(() => undefined)
  const iterator = runSnapshotJournalReconciliation(f.source, async () => f.destination, { signal: controller.signal })
  expect((await iterator.next()).value.state).toBe('cancelRequested')
  let settled = false
  const next = iterator.next().then(value => {
    settled = true
    return value
  })
  await entered.promise
  expect(settled).toBe(false)
  expect(f.intake).not.toHaveBeenCalled()
  drained.resolve()
  expect((await next).value).toMatchObject({ state: 'stopped', progress: { commits: 0 } })
  await iterator.next()
  expect(f.close).toHaveBeenCalledTimes(1)
})

test('a secondary physical cleanup failure is not converted into stopped cancellation', async () => {
  const f = fixture(),
    controller = new AbortController(),
    drained = gate()
  const cancellation = new SnapshotCancelledError('Source capture cancelled')
  const cleanup = new Error('Source connection did not close')
  controller.abort(cancellation)
  f.close.mockRejectedValue(cancellation)
  f.source.closed = drained.promise.then(() => {
    throw cleanup
  })
  void f.source.closed.catch(() => undefined)
  const states: string[] = []
  const iterator = runSnapshotJournalReconciliation(f.source, async () => f.destination, {
    signal: controller.signal,
    onProgress(value) {
      states.push(value.state)
    }
  })
  expect((await iterator.next()).value.state).toBe('cancelRequested')
  const failed = expect(iterator.next()).rejects.toBe(cleanup)
  drained.resolve()
  await failed
  expect(states).toEqual(['cancelRequested'])
  expect(f.intake).not.toHaveBeenCalled()
  expect(f.promote).not.toHaveBeenCalled()
})

test('concurrent abort cannot conceal an uncommitted validation error', async () => {
  const f = fixture(),
    controller = new AbortController()
  const invalid = new Error('Delta frame does not match the authenticated source')
  f.intake.mockImplementationOnce(async () => {
    controller.abort()
    throw invalid
  })
  const states: string[] = []
  const iterator = runSnapshotJournalReconciliation(f.source, async () => f.destination, {
    signal: controller.signal,
    onProgress(value) {
      states.push(value.state)
    }
  })
  await expect(iterator.next()).rejects.toBe(invalid)
  expect(states).toEqual([])
  expect(f.promote).not.toHaveBeenCalled()
  expect(f.close).toHaveBeenCalledTimes(1)
})

test('cancellation during intake reports stopped only for its actual uncommitted reason', async () => {
  const f = fixture(),
    controller = new AbortController()
  const cancellation = new SnapshotCancelledError('Source capture cancelled during intake')
  f.intake.mockImplementationOnce(async () => {
    controller.abort(cancellation)
    throw cancellation
  })
  const values = []
  for await (const value of runSnapshotJournalReconciliation(f.source, async () => f.destination, {
    signal: controller.signal
  }))
    values.push(value)
  expect(values.map(value => value.state)).toEqual(['cancelRequested', 'stopped'])
  expect(values[1].progress).toEqual({ commits: 0, pages: 0, examined: 0, payloadBytes: 0, inserts: 0, updates: 0 })
  expect(f.promote).not.toHaveBeenCalled()
  expect(f.close).toHaveBeenCalledTimes(1)
})
