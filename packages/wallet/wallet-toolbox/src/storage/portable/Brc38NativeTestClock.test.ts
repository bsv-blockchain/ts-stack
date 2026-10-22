import { waitForNativeTestExpiry } from './Brc38NativeTestClock'

afterEach(() => {
  jest.restoreAllMocks()
  jest.useRealTimers()
})

test('an early timer wake cannot establish actual UTC expiry', async () => {
  jest.useFakeTimers({ now: 1000 })
  const schedule = global.setTimeout
  const timer = jest
    .spyOn(global, 'setTimeout')
    .mockImplementationOnce((callback, delay, ...args) => schedule(callback, Number(delay) - 2, ...args))
  let expired = false
  const waiting = waitForNativeTestExpiry(1100).then(() => {
    expired = true
  })
  await jest.advanceTimersByTimeAsync(99)
  expect(Date.now()).toBe(1099)
  expect(expired).toBe(false)
  expect(timer).toHaveBeenCalledTimes(2)
  await jest.advanceTimersByTimeAsync(2)
  await waiting
  expect(Date.now()).toBeGreaterThanOrEqual(1100)
  expect(expired).toBe(true)
  expect(jest.getTimerCount()).toBe(0)
})

test.each([1000, 999])('an expiry already reached at %i needs no timer', async expiresAt => {
  jest.useFakeTimers({ now: 1000 })
  const timer = jest.spyOn(global, 'setTimeout')
  await waitForNativeTestExpiry(expiresAt)
  expect(timer).not.toHaveBeenCalled()
})

test.each([0, -1, NaN, Infinity, 1.5])('invalid fixture expiry %p is refused', async expiresAt => {
  await expect(waitForNativeTestExpiry(expiresAt)).rejects.toThrow('positive UTC millisecond')
})
