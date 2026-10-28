import { jest } from '@jest/globals'
import type { Response } from 'express'
import type {
  AuthenticatedResponseCandidate,
  AuthenticatedResponseQueueGuard
} from '@bsv/auth-express-middleware'
import { OutputProtocolError } from '@bsv/sdk'
import type { RootAdvertisementSendJournal } from '../RootEvictionResponseGuard.js'
import { guardRootAdvertisementResponse } from '../RootEvictionResponseGuard.js'

// A deliberately incomplete transport collaborator exercises fail-closed
// handling that the real middleware normally prevents before this boundary.
let mockInstalled: AuthenticatedResponseQueueGuard
jest.mock('@bsv/auth-express-middleware', () => ({
  guardAuthenticatedResponse(_res: Response, guard: AuthenticatedResponseQueueGuard) {
    mockInstalled = guard
  }
}))
const candidate = (attempt: 0 | 1): AuthenticatedResponseCandidate => ({
  attempt,
  statusCode: 200,
  headers: {},
  body: new Uint8Array([1]),
  identityKey: 'fixture-authenticated-caller',
  requestId: 'fixture-transport-request'
})

it('refuses an unprepared second attempt instead of treating original data as a control response', async () => {
  const enqueue = jest.fn<RootAdvertisementSendJournal['enqueue']>(),
    native = jest.fn()
  guardRootAdvertisementResponse({} as Response, {
    journal: { head: async () => ({ revision: '1' }), enqueue },
    revision: '0',
    targets: [],
    authorize: () => true,
    controlHeaders: {}
  })
  await expect(mockInstalled(candidate(1), native, new AbortController().signal)).rejects.toThrow(
    /Missing root control-response fence/
  )
  expect(enqueue).not.toHaveBeenCalled()
  expect(native).not.toHaveBeenCalled()
})

it('observes cancellation at the actual gate and never prepares a fallback afterward', async () => {
  const controller = new AbortController(),
    authorize = jest.fn(() => true),
    head = jest.fn<RootAdvertisementSendJournal['head']>(),
    native = jest.fn()
  guardRootAdvertisementResponse({} as Response, {
    journal: {
      head,
      async enqueue(_candidate, check) {
        controller.abort()
        expect(check()).toBe(false)
        throw new OutputProtocolError('unauthorized', 'cancelled at gate')
      }
    },
    revision: '0',
    targets: [],
    authorize,
    controlHeaders: {}
  })
  await expect(mockInstalled(candidate(0), native, controller.signal)).rejects.toMatchObject({
    code: 'unauthorized'
  })
  expect(authorize).not.toHaveBeenCalled()
  expect(head).not.toHaveBeenCalled()
  expect(native).not.toHaveBeenCalled()
})

it.each(['queued', 'missing', 'failed-after-queue', 'lookalike-error'])(
  'preserves the exact final journal completion contract (%s)',
  async mode => {
    const native = jest.fn(),
      head = jest.fn(async () => ({ revision: '1' })),
      failure =
        mode === 'lookalike-error'
          ? Object.assign(new Error('unrecognized local error'), { code: 'reset-required' })
          : new OutputProtocolError('unavailable', 'uncertain local acknowledgement', true)
    guardRootAdvertisementResponse({} as Response, {
      journal: {
        head,
        async enqueue(bytes, authorize, queue) {
          expect(authorize()).toBe(true)
          if (mode === 'queued' || mode === 'failed-after-queue') queue(bytes.bytes)
          if (mode === 'failed-after-queue' || mode === 'lookalike-error') throw failure
        }
      },
      revision: '0',
      targets: [],
      authorize: () => true,
      controlHeaders: {}
    })
    const pending = Promise.resolve(
      mockInstalled(candidate(0), native, new AbortController().signal)
    )
    if (mode === 'queued') await expect(pending).resolves.toBeUndefined()
    else if (mode === 'missing')
      await expect(pending).rejects.toThrow('Root journal did not enqueue the response.')
    else await expect(pending).rejects.toBe(failure)
    expect(native).toHaveBeenCalledTimes(mode === 'queued' || mode === 'failed-after-queue' ? 1 : 0)
    expect(head).not.toHaveBeenCalled()
  }
)
