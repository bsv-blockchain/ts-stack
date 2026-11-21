import { commitSyncAdmission } from './commitSyncAdmission'
import { StorageAccessQueue } from './StorageAccessQueue'
import { StorageAccessCancelledError } from './StorageAccessCancelledError'

test('normalizes only cancellation of the original queued operation before ownership', async () => {
  const queue = new StorageAccessQueue(),
    controller = new AbortController(),
    owner = await queue.acquire('exclusive')
  const operation = jest.fn(async () => 7)
  const pending = commitSyncAdmission(
    async run => {
      const release = await queue.acquire('exclusive', 'background', controller.signal)
      try {
        return await run()
      } finally {
        release()
      }
    },
    operation,
    controller.signal
  )
  controller.abort(new Error('cancel before admission'))
  try {
    expect(await pending).toBeUndefined()
    expect(operation).not.toHaveBeenCalled()
  } finally {
    owner()
  }
})

test('preserves an in-flight error even if it is a cancellation error for the same signal', async () => {
  const controller = new AbortController()
  const cause = new StorageAccessCancelledError(controller.signal)
  await expect(
    commitSyncAdmission(
      async run => await run(),
      async () => {
        controller.abort()
        throw cause
      },
      controller.signal
    )
  ).rejects.toBe(cause)
})

test('preserves unrelated queue or provider failure after cancellation', async () => {
  const controller = new AbortController(),
    foreign = new AbortController(),
    cause = new StorageAccessCancelledError(foreign.signal)
  controller.abort()
  await expect(
    commitSyncAdmission(
      async () => {
        throw cause
      },
      async () => 7,
      controller.signal
    )
  ).rejects.toBe(cause)
  const providerFailure = new Error('lost acknowledgement')
  await expect(
    commitSyncAdmission(
      async () => {
        throw providerFailure
      },
      async () => 7,
      controller.signal
    )
  ).rejects.toBe(providerFailure)
})
