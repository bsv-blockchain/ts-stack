import { afterEach, describe, expect, it, jest } from '@jest/globals'
import { AuthFetch } from '../AuthFetch.js'
import type { WalletInterface } from '../../../wallet/Wallet.interfaces.js'

type CertificatePeer = { pendingCertificateRequests: boolean[] }
type WaitPort = {
  wait(ms: number): Promise<void>
  waitForPendingCertificateRequests(peer: CertificatePeer): Promise<void>
}
const createWaiter = (): WaitPort => new AuthFetch({} as WalletInterface) as unknown as WaitPort

afterEach(() => jest.restoreAllMocks())

describe('certificate wait ordering and deadline compatibility', () => {
  it('does not schedule a delay for an already empty queue', async () => {
    const waiter = createWaiter()
    const wait = jest.spyOn(waiter, 'wait').mockRejectedValue(new Error('Unexpected delay'))
    await expect(
      waiter.waitForPendingCertificateRequests({ pendingCertificateRequests: [] })
    ).resolves.toBeUndefined()
    expect(wait).not.toHaveBeenCalled()
  })

  it('starts one delay at a time and observes completion before scheduling another', async () => {
    const waiter = createWaiter()
    const peer = { pendingCertificateRequests: [true] }
    let release: (() => void) | undefined
    const wait = jest
      .spyOn(waiter, 'wait')
      .mockRejectedValue(new Error('Unexpected repeated delay'))
      .mockImplementationOnce(
        () =>
          new Promise<void>(resolve => {
            release = resolve
          })
      )
    // Observe rejection before assertions so a changed deadline cannot leave a
    // rejected background promise when an earlier assertion fails.
    const settled = waiter.waitForPendingCertificateRequests(peer).then(
      () => ({ completed: true }),
      error => ({ error })
    )
    try {
      expect(wait).toHaveBeenCalledTimes(1)
      expect(wait).toHaveBeenCalledWith(100)
      await Promise.resolve()
      expect(wait).toHaveBeenCalledTimes(1)
      peer.pendingCertificateRequests.length = 0
      expect(release).toBeDefined()
      release!()
      await expect(settled).resolves.toEqual({ completed: true })
      expect(wait).toHaveBeenCalledTimes(1)
    } finally {
      peer.pendingCertificateRequests.length = 0
      release?.()
      await settled
    }
  })

  it('allows the exact deadline but rejects the next check after it without another delay', async () => {
    const waiter = createWaiter()
    const peer = { pendingCertificateRequests: [true] }
    jest
      .spyOn(Date, 'now')
      .mockReturnValueOnce(1000)
      .mockReturnValueOnce(31_000)
      .mockReturnValue(31_001)
    // If the production deadline check is removed, a second wait fails clearly
    // instead of starving timers in an endless loop of fulfilled mock promises.
    const wait = jest
      .spyOn(waiter, 'wait')
      .mockRejectedValue(new Error('Unexpected delay after the deadline'))
      .mockResolvedValueOnce(undefined)
    await expect(waiter.waitForPendingCertificateRequests(peer)).rejects.toThrow(
      'Timeout waiting for certificate request to complete'
    )
    expect(wait).toHaveBeenCalledTimes(1)
    expect(wait).toHaveBeenCalledWith(100)
  })

  it('propagates a failed delay unchanged without starting another', async () => {
    const waiter = createWaiter()
    const error = new Error('wait failed')
    const wait = jest.spyOn(waiter, 'wait').mockRejectedValue(error)
    await expect(
      waiter.waitForPendingCertificateRequests({ pendingCertificateRequests: [true] })
    ).rejects.toBe(error)
    expect(wait).toHaveBeenCalledTimes(1)
  })
})
