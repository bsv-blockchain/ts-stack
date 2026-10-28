import { afterEach, describe, expect, it, jest } from '@jest/globals'

const originalExitCode = process.exitCode

afterEach(() => {
  process.exitCode = originalExitCode
  jest.restoreAllMocks()
  jest.dontMock('@bsv/paymail')
  jest.dontMock('../../docs/examples/src/mockUser')
  jest.resetModules()
})

describe.each([
  ['getPki', 'getPki', 'pki1', 'pki2'],
  ['getProfile', 'getPublicProfile', 'publicProfile1', 'publicProfile2']
])('Paymail %s command', (example, method, firstKey, secondKey) => {
  it.each([false, true])('reports completion or failure (reject=%s)', async reject => {
    const failure = new Error('lookup unavailable')
    const lookup = jest.fn<(paymail: string) => Promise<string>>()
    if (reject) lookup.mockRejectedValue(failure)
    else lookup.mockResolvedValueOnce('first result').mockResolvedValueOnce('second result')
    const log = jest.spyOn(console, 'log').mockImplementation(() => {})
    const error = jest.spyOn(console, 'error').mockImplementation(() => {})
    process.exitCode = undefined
    jest.doMock('../../docs/examples/src/mockUser', () => ({
      mockUser1: { getPaymail: () => 'alice@example.com' },
      mockUser2: { getPaymail: () => 'bob@example.com' }
    }))
    jest.doMock('@bsv/paymail', () => ({
      PaymailClient: jest.fn().mockImplementation(() => ({ [method]: lookup }))
    }))

    await jest.isolateModulesAsync(async () => {
      await import(`../../docs/examples/src/client/${example}.js`)
      await new Promise<void>(resolve => setImmediate(resolve))
    })

    if (reject) {
      expect(lookup).toHaveBeenCalledTimes(1)
      expect(error).toHaveBeenCalledWith(failure)
      expect(log).not.toHaveBeenCalled()
      expect(process.exitCode).toBe(1)
    } else {
      expect(lookup).toHaveBeenNthCalledWith(1, 'alice@example.com')
      expect(lookup).toHaveBeenNthCalledWith(2, 'bob@example.com')
      expect(lookup).toHaveBeenCalledTimes(2)
      expect(log).toHaveBeenCalledWith({ [firstKey]: 'first result', [secondKey]: 'second result' })
      expect(error).not.toHaveBeenCalled()
      expect(process.exitCode).toBeUndefined()
    }
  })
})
