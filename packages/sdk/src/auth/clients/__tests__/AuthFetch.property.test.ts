import fc from 'fast-check'
import { jest } from '@jest/globals'

import * as Utils from '../../../primitives/utils.js'
import { AuthFetch } from '../AuthFetch.js'

const MIN_PROPERTY_RUNS = 300
const requestedRuns = Number.parseInt(process.env.FAST_CHECK_NUM_RUNS ?? '', 10)
const requestedSeed = Number.parseInt(process.env.FAST_CHECK_SEED ?? '', 10)
const replayPath = process.env.FAST_CHECK_PATH

fc.configureGlobal({
  numRuns: Number.isSafeInteger(requestedRuns)
    ? Math.max(MIN_PROPERTY_RUNS, requestedRuns)
    : MIN_PROPERTY_RUNS,
  ...(Number.isSafeInteger(requestedSeed) ? { seed: requestedSeed } : {}),
  ...(replayPath !== undefined && replayPath !== '' ? { path: replayPath } : {})
})

describe('AuthFetch authenticated response boundary properties', () => {
  test('arbitrary bounded response fields always settle and release request state', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 0, max: 252 }),
        fc.integer({ min: 0, max: 252 }),
        fc.uint8Array({ maxLength: 256 }),
        async (status, declaredBodyLength, remoteBody) => {
          let generalMessage: ((senderPublicKey: string, payload: number[]) => void) | undefined
          const stopListeningForGeneralMessages = jest.fn()
          const peer = {
            listenForGeneralMessages: jest.fn(listener => {
              generalMessage = listener
              return 73
            }),
            stopListeningForGeneralMessages,
            toPeer: jest.fn(async (payload: number[]) => {
              const response = new Utils.Writer()
              response.write(payload.slice(0, 32))
              response.writeVarIntNum(status)
              response.writeVarIntNum(0)
              response.writeVarIntNum(declaredBodyLength)
              response.write(Array.from(remoteBody))
              generalMessage?.('server-identity-key', response.toArray())
            })
          }
          const authFetch = new AuthFetch({} as never)
          ;(authFetch as any).peers['https://service.example'] = {
            peer,
            identityKey: 'server-identity-key',
            supportsMutualAuth: true,
            pendingCertificateRequests: []
          }

          await authFetch.fetch('https://service.example/resource').then(
            () => {},
            () => {}
          )

          expect(stopListeningForGeneralMessages).toHaveBeenCalledWith(73)
          expect((authFetch as any).pendingRequestNonces.size).toBe(0)
        }
      )
    )
  })
})
