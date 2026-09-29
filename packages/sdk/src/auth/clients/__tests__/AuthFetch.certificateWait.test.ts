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
    const wait = jest.spyOn(waiter, 'wait')
    await expect(
      waiter.waitForPendingCertificateRequests({ pendingCertificateRequests: [] })
    ).resolves.toBeUndefined()
    expect(wait).not.toHaveBeenCalled()
  })

  it('starts one delay at a time and observes completion before scheduling another', async () => {
    const waiter = createWaiter()
    const peer = { pendingCertificateRequests: [true] }
    let release!: () => void
    const wait = jest.spyOn(waiter, 'wait').mockImplementation(
      () =>
        new Promise<void>(resolve => {
          release = resolve
        })
    )
    const result = waiter.waitForPendingCertificateRequests(peer)
    expect(wait).toHaveBeenCalledTimes(1)
    expect(wait).toHaveBeenCalledWith(100)
    await Promise.resolve()
    expect(wait).toHaveBeenCalledTimes(1)
    peer.pendingCertificateRequests.length = 0
    release()
    await result
    expect(wait).toHaveBeenCalledTimes(1)
  })

  it('allows the exact deadline but rejects the next check after it without another delay', async () => {
    const waiter = createWaiter()
    const peer = { pendingCertificateRequests: [true] }
    jest
      .spyOn(Date, 'now')
      .mockReturnValueOnce(0)
      .mockReturnValueOnce(30_000)
      .mockReturnValue(30_001)
    const wait = jest.spyOn(waiter, 'wait').mockResolvedValue(undefined)
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
