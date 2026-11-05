import { expect, it, jest } from '@jest/globals'
import { stat } from 'node:fs/promises'
import { fixture } from './root-eviction-fixture.js'

it('closes the reopened native journal and removes its directory after an earlier close acknowledgement fails', async () => {
  const owned = await fixture(),
    reopened = owned.reopen(),
    closeOriginal = owned.store.close.bind(owned.store),
    failure = new Error('Synthetic close acknowledgement failure'),
    closeReopened = jest.spyOn(reopened, 'close')
  jest.spyOn(owned.store, 'close').mockImplementationOnce(async () => {
    await closeOriginal()
    throw failure
  })
  try {
    await expect(owned.cleanup()).rejects.toMatchObject({ errors: [failure] })
    expect(closeReopened).toHaveBeenCalledTimes(1)
    await expect(stat(owned.directory)).rejects.toMatchObject({ code: 'ENOENT' })
  } finally {
    jest.restoreAllMocks()
    await owned.cleanup()
  }
})
